import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { defineSecret } from 'firebase-functions/params';
import { HttpsError, onCall } from 'firebase-functions/v2/https';

initializeApp();
const db = getFirestore();
const auth = getAuth();
const options = { region: 'asia-south1', maxInstances: 2, timeoutSeconds: 30 };
const hash = value => createHash('sha256').update(value).digest('hex');
const emailFor = username => `${username}@members.igct.invalid`;
const rejected = () => new HttpsError('failed-precondition', 'Ask your admin friend for a fresh PIN reset code.');
const joinPassword = defineSecret('IGCT_JOIN_PASSWORD');

export const registerClubMember = onCall({ ...options, secrets: [joinPassword] }, async request => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in first.');
  const { username, nickname, password, invite } = request.data || {};
  if (typeof username !== 'string' || !/^[a-z0-9_]{3,16}$/.test(username) ||
      typeof nickname !== 'string' || nickname.length < 2 || nickname.length > 20 ||
      typeof invite !== 'string' || (invite && !/^[A-Za-z0-9_-]{32}$/.test(invite)) ||
      typeof password !== 'string' || password.length > 80 ||
      request.auth.token.email !== emailFor(username)) {
    throw new HttpsError('invalid-argument', 'Check your registration details.');
  }
  const expected = joinPassword.value().trim();
  if (!expected) throw new HttpsError('unavailable', 'Club registration is not configured yet.');

  // Track attempts even when the supplied password is invalid.
  const source = hash(request.rawRequest.ip || 'unknown');
  const bucket = Math.floor(Date.now() / (15 * 60 * 1000));
  await db.runTransaction(async tx => {
    const ref = db.doc(`clubJoinAttempts/${source}`);
    const previous = (await tx.get(ref)).data();
    const count = previous?.bucket === bucket ? previous.count : 0;
    if (count >= 12) throw new HttpsError('resource-exhausted', 'Too many attempts. Try again in 15 minutes.');
    tx.set(ref, { bucket, count: count + 1 });
  });
  if (!timingSafeEqual(Buffer.from(hash(password), 'hex'), Buffer.from(hash(expected), 'hex'))) {
    throw new HttpsError('permission-denied', 'The join password did not match.');
  }

  const member = db.doc(`members/${uid}`);
  const club = db.doc('system/club');
  const info = db.doc('system/groupInfo');
  const generated = randomBytes(24).toString('base64url');
  const generatedHash = hash(generated);
  return db.runTransaction(async tx => {
    const [existing, group, infoDoc] = await Promise.all([tx.get(member), tx.get(club), tx.get(info)]);
    if (existing.exists) {
      if (existing.data().status !== 'active') throw new HttpsError('permission-denied', 'This account is unavailable.');
      return { joined: true };
    }
    const createdAt = FieldValue.serverTimestamp();
    const memberData = { uid, status: 'active', chatMuted: false, uploadsDisabled: false, createdAt };
    const profile = db.doc(`profiles/${uid}`);
    if (group.exists || infoDoc.exists) {
      if (!invite) throw new HttpsError('failed-precondition', 'This team already exists. Ask the admin for an invite code.');
      const inviteHash = hash(invite);
      const inviteDoc = await tx.get(db.doc(`invites/${inviteHash}`));
      if (!inviteDoc.data()?.active || group.data()?.inviteHash !== inviteHash) {
        throw new HttpsError('failed-precondition', 'That invite code expired or is incorrect.');
      }
      tx.create(member, { ...memberData, role: 'member', inviteProof: inviteHash });
      tx.create(profile, { uid, username, nickname, avatar: '🦊', createdAt });
      return { joined: true };
    }
    if (invite) throw new HttpsError('failed-precondition', 'A team has not been created yet.');
    const groupName = 'THE INVENCIABLE GAME CHANGERS TEAM (IGCT)';
    tx.create(club, { groupName, adminUid: uid, inviteHash: generatedHash, createdAt });
    tx.create(info, { groupName, createdAt });
    tx.create(member, { ...memberData, role: 'admin' });
    tx.create(profile, { uid, username, nickname, avatar: '🦊', createdAt });
    tx.create(db.doc(`invites/${generatedHash}`), { active: true, createdBy: uid, createdAt });
    return { joined: true, invite: generated };
  });
});

export const allowPinReset = onCall(options, async request => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  const uid = request.data?.uid;
  if (typeof uid !== 'string' || !/^[A-Za-z0-9]{1,128}$/.test(uid) || uid === request.auth.uid) {
    throw new HttpsError('invalid-argument', 'Choose another active teammate.');
  }
  const code = randomBytes(16).toString('hex').toUpperCase();
  await db.runTransaction(async tx => {
    const [admin, member, profile] = await Promise.all([
      tx.get(db.doc(`members/${request.auth.uid}`)),
      tx.get(db.doc(`members/${uid}`)),
      tx.get(db.doc(`profiles/${uid}`))
    ]);
    if (admin.data()?.status !== 'active' || admin.data()?.role !== 'admin') {
      throw new HttpsError('permission-denied', 'Only a team admin can allow a reset.');
    }
    const username = profile.data()?.username;
    if (member.data()?.status !== 'active' || !/^[a-z0-9_]{3,16}$/.test(username || '')) {
      throw new HttpsError('failed-precondition', 'That teammate is not active.');
    }
    const reset = db.doc(`pinResets/${username}`);
    const previous = (await tx.get(reset)).data();
    const now = Date.now();
    if ((previous?.busyUntil || 0) > now) throw new HttpsError('aborted', 'A PIN reset is already in progress. Try again in a minute.');
    tx.set(reset, { uid, approvedBy: request.auth.uid, digest: hash(code), expires: now + 15 * 60 * 1000 });
  });
  return { code: code.match(/.{1,4}/g).join('-') };
});

function resetInput(data) {
  const username = typeof data?.username === 'string' ? data.username.trim().toLowerCase().replace(/^@/, '') : '';
  const code = typeof data?.code === 'string' && data.code.length <= 80 ? data.code.replace(/[\s-]/g, '').toUpperCase() : '';
  if (!/^[a-z0-9_]{3,16}$/.test(username) || !/^[A-F0-9]{32}$/.test(code)) throw rejected();
  return { username, code };
}
function validCode(record, code) {
  return record?.expires > Date.now() && /^[a-f0-9]{64}$/.test(record.digest || '') &&
    timingSafeEqual(Buffer.from(record.digest, 'hex'), Buffer.from(hash(code), 'hex'));
}
async function readApproval(tx, reset, username, code) {
  const record = (await tx.get(reset)).data();
  if (!validCode(record, code)) throw rejected();
  const [member, approver, profile] = await Promise.all([
    tx.get(db.doc(`members/${record.uid}`)),
    tx.get(db.doc(`members/${record.approvedBy}`)),
    tx.get(db.doc(`profiles/${record.uid}`))
  ]);
  if (member.data()?.status !== 'active' || approver.data()?.status !== 'active' ||
      approver.data()?.role !== 'admin' || profile.data()?.username !== username) throw rejected();
  return record;
}

export const checkPinReset = onCall(options, async request => {
  const { username, code } = resetInput(request.data);
  await db.runTransaction(tx => readApproval(tx, db.doc(`pinResets/${username}`), username, code));
  return { allowed: true };
});

export const finishPinReset = onCall(options, async request => {
  const { username, code } = resetInput(request.data);
  const password = request.data?.password;
  if (typeof password !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(password)) {
    throw new HttpsError('invalid-argument', 'Choose a new four-digit PIN.');
  }
  const reset = db.doc(`pinResets/${username}`);
  const uid = await db.runTransaction(async tx => {
    const record = await readApproval(tx, reset, username, code);
    // Consume first so simultaneous requests cannot both change the password.
    tx.set(reset, { uid: record.uid, busyUntil: Date.now() + 60000 });
    return record.uid;
  });
  try {
    const account = await auth.getUser(uid);
    if (account.disabled || account.email !== emailFor(username)) throw rejected();
    await auth.updateUser(uid, { password });
    await auth.revokeRefreshTokens(uid);
    await reset.delete();
  } catch (error) {
    console.error('PIN reset could not finish', error.code || 'unknown');
    throw new HttpsError('unavailable', 'Try signing in with the new PIN. If it fails, ask your admin for a fresh code.');
  }
  return { changed: true };
});
