import { initializeApp, cert } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

const credentials = process.env.IGCT_FIREBASE_CREDENTIALS;
if (!credentials) throw new Error('Set the IGCT_FIREBASE_CREDENTIALS Actions secret.');
const serviceAccount = JSON.parse(credentials);
if (serviceAccount.project_id !== 'igct-game-changers-club') {
  throw new Error('The service account must belong to the IGCT Firebase project.');
}
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();
const weekMillis = 604800000;
const now = Date.now();
const currentWeek = now + 86400000 - (now + 365400000) % weekMillis;
const awards = [100, 50, 25];

const [art, ballots, legacyVotes, legacySlots] = await Promise.all(
  ['weeklyArt', 'weeklyBallots', 'artVotes', 'artSlots'].map(name =>
    db.collection(name).where('week', '<', currentWeek).get())
);
const weeks = new Set([...art.docs, ...ballots.docs, ...legacyVotes.docs, ...legacySlots.docs]
  .map(item => item.data().week).filter(Number.isSafeInteger));

for (const week of [...weeks].sort((a, b) => a - b)) {
  const entries = art.docs.filter(item => item.data().week === week);
  const votes = ballots.docs.filter(item => item.data().week === week);
  const oldVotes = legacyVotes.docs.filter(item => item.data().week === week);
  const oldSlots = legacySlots.docs.filter(item => item.data().week === week);
  const entriesById = new Map(entries.map(entry => [entry.id, entry.data()]));
  const counted = new Map();
  const newVoters = new Set(votes.map(vote => vote.data().uid));

  function count(voter, ids) {
    for (const id of ids) {
      const entry = entriesById.get(id);
      if (entry && entry.uid !== voter) counted.set(id, (counted.get(id) || 0) + 1);
    }
  }
  votes.forEach(vote => {
    const data = vote.data();
    count(data.uid, Object.keys(data.choices || {}).slice(0, 10));
  });
  oldVotes.forEach(vote => {
    if (!newVoters.has(vote.id)) count(vote.id, [vote.data().art]);
  });
  const result = db.collection('artResults').doc(String(week));
  const podium = await db.runTransaction(async tx => {
    const previous = await tx.get(result);
    if (previous.exists) return previous.data().podium || [];
    const ranked = [...counted].sort(([a, n], [b, m]) => m - n || a.localeCompare(b))
      .slice(0, awards.length).map(([artId, votes], index) => ({
        artId, nickname: entriesById.get(artId).nickname, votes, stars: awards[index]
      }));
    const totals = new Map();
    for (const place of ranked) {
      const { uid } = entriesById.get(place.artId);
      totals.set(uid, (totals.get(uid) || 0) + place.stars);
    }
    for (const [uid, stars] of totals) {
      tx.set(db.collection('scores').doc(uid), {
        uid, points: FieldValue.increment(stars), updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }
    tx.create(result, { week, podium: ranked, closedAt: FieldValue.serverTimestamp() });
    return ranked;
  });
  const kept = new Set(podium.map(place => place.artId));
  const documents = [...entries.filter(entry => !kept.has(entry.id)), ...votes, ...oldVotes, ...oldSlots];
  for (let offset = 0; offset < documents.length; offset += 400) {
    const batch = db.batch();
    documents.slice(offset, offset + 400).forEach(item => batch.delete(item.ref, { lastUpdateTime: item.updateTime }));
    await batch.commit();
  }
  console.log(`Closed week ${new Date(week).toISOString()} and removed ${documents.length} documents.`);
}
