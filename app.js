import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js';
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  deleteUser, signOut, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js';
import {
  getFirestore, where, deleteField, collection, doc, getDoc, getDocs, addDoc, setDoc, updateDoc,
  deleteDoc, query, orderBy, limit, onSnapshot, runTransaction, serverTimestamp,
  increment, writeBatch
} from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js';
import { setupDrawingTools } from './drawing.js';
import { firebaseConfig } from './firebase-config.js';

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);
const byId = id => document.getElementById(id);
const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];
const words = ['🦊','🐼','🐯','🐸','🐙','🐲'];
let me = null;
let membersCache = [];
let chatStop = null;
let stopDailyScore = null;
let activeTab = "home";
let chatMuted = false;
let uploadsDisabled = false;
let gameTabLoaded = false;

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cleanUsername = value => value.trim().toLowerCase();
const validUsername = value => /^[a-z0-9_]{3,16}$/.test(value);
const showMessage = (text, kind = 'info') => {
  const box = byId('club-message');
  if (!box) return;
  box.textContent = text;
  box.dataset.kind = kind;
  box.classList.add('show');
  clearTimeout(showMessage.timer);
  showMessage.timer = setTimeout(() => box.classList.remove('show'), 4200);
};
const writeFormError = (id, message) => { if (byId(id)) byId(id).textContent = message; };

async function pinPassword(username, pin) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(`IGCT|${username}|${pin}`), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: encoder.encode(`igct-kids-v1:${username}`), iterations: 160000, hash: 'SHA-256' }, key, 256);
  return btoa(String.fromCharCode(...new Uint8Array(bits))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
}
async function digestText(value) {
  const bits = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bits)].map(v => v.toString(16).padStart(2, '0')).join('');
}
function randomInvite() {
  const data = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...data)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
}
function pseudoEmail(username) { return `${username}@members.igct.invalid`; }
function authFriendlyError(error) {
  const errors = {
    'auth/email-already-in-use': 'That username is already taken. Try another one.',
    'auth/invalid-credential': 'That username and PIN did not match. Try again or ask a grown-up.',
    'auth/invalid-email': 'That username could not be used. Try a different one.',
    'auth/weak-password': 'Could not create the account. Please choose a different PIN.',
    'auth/too-many-requests': 'Too many tries right now. Take a little break, then ask a grown-up for help.',
    'permission-denied': 'The group setup is not ready yet. Ask the grown-up who is helping your team.',
    'unavailable': 'The club is having a little connection problem. Try again soon.'
  };
  return errors[error?.code] || errors[error?.code?.replace('firestore/','')] || 'Something went wrong. Ask your grown-up for help.';
}
function memberRef(uid) { return doc(db, 'members', uid); }
function profileRef(uid) { return doc(db, 'profiles', uid); }
function settingsRef() { return doc(db, 'system', 'club'); }
function groupInfoRef() { return doc(db, 'system', 'groupInfo'); }

// Preserve the QR invite from the landing page when a kid taps Join.
const joinLink = byId('join-link');
if (joinLink && new URLSearchParams(location.search).has('invite')) {
  joinLink.href = `join.html${location.search}`;
}
const inviteInput = byId('invite-code');
if (inviteInput) inviteInput.value = new URLSearchParams(location.search).get('invite') || '';

function avatarMarkup(profile) {
  const photo = profile.avatarPhoto;
  if (typeof photo === 'string' && photo.length <= 20000 &&
      /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(photo)) {
    return `<img src="${photo}" width="28" height="28" alt="" style="border-radius:50%;object-fit:cover;vertical-align:middle">`;
  }
  return escapeHtml(profile.avatar || '⭐');
}

async function makeAvatar(file) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
    throw new Error('Choose a JPG, PNG or WebP under 5 MB.');
  }
  const image = await createImageBitmap(file);
  try {
    const size = Math.min(image.width, image.height);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 96;
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, 96, 96);
    context.drawImage(image, (image.width - size) / 2, (image.height - size) / 2, size, size, 0, 0, 96, 96);
    const icon = canvas.toDataURL('image/jpeg', 0.72);
    if (icon.length > 20000) throw new Error('Choose a simpler image.');
    return icon;
  } finally {
    image.close();
  }
}

// First account initializes the team as admin. The QR is created only after that account exists.
byId('join-form')?.addEventListener('submit', async event => {
  event.preventDefault();
  writeFormError('join-error', '');
  const nickname = byId('nickname').value.trim();
  const username = cleanUsername(byId('username').value);
  const pin = byId('pin').value;
  const pinAgain = byId('pin-again').value;
  const invite = (byId('invite-code')?.value || '').trim();
  if (nickname.length < 2) return writeFormError('join-error', 'Choose a nickname with at least two characters.');
  if (!validUsername(username)) return writeFormError('join-error', 'Use 3–16 letters, numbers, or underscores in your username.');
  if (!/^\d{4}$/.test(pin)) return writeFormError('join-error', 'Your PIN needs to be exactly four numbers.');
  if (pin !== pinAgain) return writeFormError('join-error', 'Those PINs do not match. Try again!');
  if (!byId('adult-check').checked) return writeFormError('join-error', 'Please ask a trusted grown-up to help you join.');
  const button = event.submitter;
  button.disabled = true;
  button.textContent = 'Setting up your team buddy…';
  let credential = null;
  try {
    const password = await pinPassword(username, pin);
    credential = await createUserWithEmailAndPassword(auth, pseudoEmail(username), password);
    const uid = credential.user.uid;
    const profile = { uid, username, nickname, avatar: '🦊', createdAt: serverTimestamp() };
    const member = { uid, role: 'member', status: 'active', chatMuted: false, uploadsDisabled: false, createdAt: serverTimestamp() };
    const generated = randomInvite();
    const generatedHash = await digestText(generated);
    const suppliedHash = invite ? await digestText(invite) : '';
    let becameAdmin = false;
    await runTransaction(db, async transaction => {
      if (!invite) {
        const group = await transaction.get(groupInfoRef());
        if (group.exists()) throw new Error('NEED_INVITE');
        becameAdmin = true;
        const inviteDoc = doc(db, 'invites', generatedHash);
        transaction.set(groupInfoRef(), { groupName: 'THE INVENCIABLE GAME CHANGERS TEAM (IGCT)', createdAt: serverTimestamp() });
        transaction.set(settingsRef(), { groupName: 'THE INVENCIABLE GAME CHANGERS TEAM (IGCT)', adminUid: uid, inviteHash: generatedHash, createdAt: serverTimestamp() });
        transaction.set(memberRef(uid), { ...member, role: 'admin' });
        transaction.set(profileRef(uid), profile);
        transaction.set(inviteDoc, { active: true, createdBy: uid, createdAt: serverTimestamp() });
      } else {
        const inviteDoc = doc(db, 'invites', suppliedHash);
        const inviteSnap = await transaction.get(inviteDoc);
        if (!inviteSnap.exists() || !inviteSnap.data().active) throw new Error('BAD_INVITE');
        transaction.set(memberRef(uid), { ...member, role: 'member', inviteProof: suppliedHash });
        transaction.set(profileRef(uid), profile);
      }
    });
    if (becameAdmin) sessionStorage.setItem('igct_invite_' + uid, generated);
    location.assign('club.html');
  } catch (error) {
    // Remove a just-created login if the invite code or the protected join transaction failed.
    if (credential?.user) {
      try { await deleteUser(credential.user); } catch { /* Keep the error kid-friendly; admin can remove a stray account. */ }
    }
    if (error.message === 'NEED_INVITE') writeFormError('join-error', 'Scan the team’s invitation QR code, or ask the admin for the invite code.');
    else if (error.message === 'BAD_INVITE') writeFormError('join-error', 'That team invite has expired. Ask the admin for a fresh QR code.');
    else writeFormError('join-error', authFriendlyError(error));
  } finally {
    button.disabled = false;
    button.innerHTML = 'Create my account <b>→</b>';
  }
});

byId('login-form')?.addEventListener('submit', async event => {
  event.preventDefault();
  writeFormError('login-error', '');
  const username = cleanUsername(byId('username').value);
  const pin = byId('pin').value;
  if (!validUsername(username) || !/^\d{4}$/.test(pin)) return writeFormError('login-error', 'Check your username and enter a 4-digit PIN.');
  const button = event.submitter;
  button.disabled = true;
  try {
    const password = await pinPassword(username, pin);
    await signInWithEmailAndPassword(auth, pseudoEmail(username), password);
    const memberSnap = await getDoc(memberRef(auth.currentUser.uid));
    if (!memberSnap.exists() || memberSnap.data().status !== 'active') {
      await signOut(auth);
      return writeFormError('login-error', 'This account is not active in the group. Ask the admin for help.');
    }
    location.assign('club.html');
  } catch (error) {
    writeFormError('login-error', authFriendlyError(error));
  } finally { button.disabled = false; }
});

const trivia = [
  { q: 'Which planet is known as the Red Planet?', a: 'Mars', options: ['Mars','Venus','Neptune'] },
  { q: 'What do bees help flowers do?', a: 'Grow seeds', options: ['Grow seeds','Make snow','Turn blue'] },
  { q: 'Which animal is the tallest?', a: 'Giraffe', options: ['Giraffe','Penguin','Rabbit'] },
  { q: 'How many sides does a triangle have?', a: 'Three', options: ['Three','Five','Eight'] },
  { q: 'What is a baby frog called?', a: 'Tadpole', options: ['Tadpole','Cub','Chick'] }
];
const missions = [
  'Give a teammate a kind compliment today.',
  'Invite someone to join your game.',
  'Thank someone who helped you.',
  'Share a smile with a friend at school.',
  'Cheer for someone’s drawing or idea.'
];
function todayInIndia() {
  return new Date(Date.now() + 19800000).toISOString().slice(0, 10);
}

async function savePoints(activity, points, today) {
  const score = doc(db, 'scores', me.uid);
  const earned = await runTransaction(db, async tx => {
    const current = await tx.get(score);
    const data = current.data();
    const daily = data?.day === today ? (data.daily || {}) : {};
    if (daily[activity]) return false;
    tx.set(score, {
      uid: me.uid, points: (data?.points || 0) + points,
      day: today, daily: { ...daily, [activity]: true }, updatedAt: serverTimestamp()
    });
    return true;
  });
  showMessage(earned ? `You earned ${points} stars! ⭐` : 'You already earned these stars today!', earned ? 'success' : 'info');
  await loadScores();
}

function starSaveError(error) {
  return error.code === 'permission-denied'
    ? 'Your stars could not be saved. Ask the club admin for help.'
    : authFriendlyError(error);
}

function renderGames() {
  const today = todayInIndia();
  const dailyNumber = Number(today.slice(-2));
  const question = trivia[dailyNumber % trivia.length];
  const mission = missions[dailyNumber % missions.length];
  const card = byId('tab-content');
  card.innerHTML = `<div class="games-grid">
    <article class="game-card trivia-game"><div class="game-top"><span>🧠</span><small>TEAM TRIVIA</small><b>+5 ⭐</b></div><h3>Quick Brain Boost</h3><p class="game-question">${question.q}</p><div class="answer-list">${question.options.map(option => `<button class="answer-choice" data-answer="${escapeHtml(option)}">${escapeHtml(option)}</button>`).join('')}</div></article>
    <article class="game-card mission-game"><div class="game-top"><span>💜</span><small>KINDNESS QUEST</small><b>+3 ⭐</b></div><h3>Today's kind mission</h3><p class="game-question">${mission}</p><button class="button button-purple full-button" id="mission-done">I did it! 🎉</button><p class="tiny-note">Do this in real life, then come back to collect your stars.</p></article>
    <article class="game-card"><h3>🎨 Doodle of the day</h3><a class="button button-purple" href="doodle.html">Try today’s doodle →</a></article>
    <article class="game-card"><h3>🔢 Number Quest <small>+4 ⭐</small></h3><p>What is ${dailyNumber} + 6?</p><div class="answer-list">${[dailyNumber + 5, dailyNumber + 7, dailyNumber + 6].sort((a,b) => (a % 3) - (b % 3)).map(n => `<button type="button" class="answer-choice" data-number="${n}">${n}</button>`).join('')}</div></article>
    <article class="game-card"><h3>💜 Kind Choice <small>+2 ⭐</small></h3><p>A teammate drops their pencils. What could you do?</p><div class="answer-list"><button class="answer-choice" data-kind="yes">Help pick them up</button><button class="answer-choice" data-kind="no">Walk past them</button></div></article>
    <article class="game-card stars-game"><div class="game-top"><span>🏆</span><small>TEAM STARS</small><b>Leaderboard</b></div><h3>Cheer each other on</h3><div id="score-list" class="score-list"><p class="tiny-note">Loading team stars…</p></div></article>
  </div>`;
  const gameView = card.firstElementChild;
  const tasks = [
    { id: 'trivia', points: 5, buttons: qsa('[data-answer]', card), correct: button => button.dataset.answer === question.a },
    { id: 'kindness', points: 3, buttons: [byId('mission-done')], correct: () => true },
    { id: 'math', points: 4, buttons: qsa('[data-number]', card), correct: button => Number(button.dataset.number) === dailyNumber + 6 },
    { id: 'choice', points: 2, buttons: qsa('[data-kind]', card), correct: button => button.dataset.kind === 'yes' }
  ];

  function paint(task, text) {
    task.buttons.forEach(button => { button.disabled = task.done || task.saving || !task.ready; });
    task.status.textContent = task.done ? '✅ Done for today' : text;
  }

  for (const task of tasks) {
    task.status = document.createElement('p');
    task.status.className = 'game-feedback';
    task.status.setAttribute('role', 'status');
    task.buttons[0].closest('.game-card').append(task.status);
    paint(task, 'Checking today’s progress…');
    for (const button of task.buttons) {
      button.addEventListener('click', async () => {
        if (todayInIndia() !== today) return selectTab('games');
        if (task.done || task.saving || !task.ready) return;
        if (!task.correct(button)) return paint(task, 'Try another answer!');
        task.saving = true;
        paint(task, 'Saving stars…');
        let message = '';
        try {
          await savePoints(task.id, task.points, today);
          task.done = true;
        } catch (error) {
          message = starSaveError(error);
        } finally {
          task.saving = false;
          paint(task, message);
        }
      });
    }
  }
  stopDailyScore = onSnapshot(doc(db, 'scores', me.uid), { includeMetadataChanges: true }, snapshot => {
    if (!gameView.isConnected || snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) return;
    const score = snapshot.data();
    for (const task of tasks) {
      task.ready = true;
      task.done ||= score?.day === today && score.daily?.[task.id] === true;
      paint(task, task.saving ? 'Saving stars…' : '');
    }
  }, error => {
    for (const task of tasks) paint(task, starSaveError(error));
  });
  loadScores();
}

async function loadScores() {
  const list = byId('score-list');
  if (!list) return;
  try {
    const [scores, profiles] = await Promise.all([
      getDocs(query(collection(db,'scores'),orderBy('points','desc'),limit(10))),
      getDocs(collection(db,'profiles'))
    ]);
    if (!list.isConnected) return;
    const profileMap = Object.fromEntries(profiles.docs.map(s=>[s.id,s.data()]));
    const rows=scores.docs.map(s=>({score:s.data(),profile:profileMap[s.id]})).filter(x=>x.profile);
    list.innerHTML=rows.length?rows.map((r,i)=>`<div class="score-row"><span class="rank">${['🥇','🥈','🥉'][i]||`${i+1}.`}</span><span>${avatarMarkup(r.profile)} ${escapeHtml(r.profile.nickname)}</span><b>${r.score.points} ⭐</b></div>`).join(''):'<p class="tiny-note">Earn the first team stars and start the cheer board!</p>';
  } catch { list.innerHTML='<p class="tiny-note">Team stars will show after Firestore is set up.</p>'; }
}

function renderHome() {
  byId('tab-content').innerHTML = `<div class="home-grid"><article class="feed-card"><div class="feed-head"><span class="feed-avatar">${avatarMarkup(me)}</span><div><strong>Welcome to IGCT, ${escapeHtml(me.nickname)}!</strong><small>Your team space is ready</small></div></div><p class="feed-body">Try a game, share a kind message, or make a team doodle. Remember: be kind, include everyone, and ask a grown-up if anything feels uncomfortable.</p><div class="feed-art" aria-label="A cheerful rainbow and flowers">🌈🌱🌼</div></article><article class="feed-card home-quick"><div class="feed-head"><span class="feed-avatar">🎮</span><div><strong>Today's team games</strong><small>Play and collect team stars!</small></div></div><button class="button button-purple full-button" data-switch="games">See the games →</button></article><article class="feed-card home-quick"><div class="feed-head"><span class="feed-avatar">🫶</span><div><strong>Today's kindness quest</strong><small>One small kind thing can make a big day.</small></div></div><p class="feed-body">Give a teammate a kind compliment today.</p></article></div>`;
  byId('tab-content').insertAdjacentHTML('afterbegin', '<article class="feed-card home-quick"><h3>🎨 Today’s doodle</h3><a class="button button-purple" href="doodle.html">Try today’s doodle →</a> <a class="reaction-button" href="#games" id="stars-link">🏆 Star leaderboard</a></article>');
  byId('stars-link').onclick = event => { event.preventDefault(); selectTab('games'); byId('score-list').scrollIntoView({block:'center'}); };
  byId('tab-content').querySelector('[data-switch]')?.addEventListener('click',()=>selectTab('games'));
}

function renderChat() {
  const pictures = new Map();
  let messagesOnScreen = [];

  byId('tab-content').innerHTML=`<section class="chat-panel"><div class="chat-guidelines">💬 Be kind 💜 Keep personal details private.</div><div id="chat-list" class="chat-list"><p class="tiny-note">Loading team chat…</p></div><form id="chat-form" class="chat-form"><label class="sr-only" for="chat-text">Write a kind team message</label><input id="chat-text" maxlength="350" placeholder="Write a kind team message…" ${chatMuted?'disabled':''} required><button class="button button-purple" type="submit" ${chatMuted?'disabled':''}>Send ✨</button></form>${chatMuted?'<p class="muted-notice">🔒 Chat paused</p>':''}</section>`;
  if(chatStop) chatStop();
  const messages=query(collection(db,'chat'),orderBy('createdAt','desc'),limit(35));
  const listView = byId("chat-list");
  function paintChat() {
    if (!listView.isConnected) return;
    const items = messagesOnScreen;
    byId('chat-list').innerHTML=items.length?items.map(item=>`<article class="chat-message"><span class="feed-avatar">${avatarMarkup(pictures.get(item.uid) || item)}</span><div class="chat-message-body"><div><b>${escapeHtml(item.nickname||'Team friend')}</b><small>${item.uid===me.uid?'you':''}</small></div><p>${escapeHtml(item.text)}</p>${me.role==='admin'?`<button class="tiny-admin-action" data-delete-message="${item.id}">Remove message</button>`:''}</div></article>`).join(''):'<p class="empty-chat">No messages yet. Say a kind hello! 👋</p>';
    qsa('[data-delete-message]').forEach(button=>button.addEventListener('click',async()=>{try{await deleteDoc(doc(db,'chat',button.dataset.deleteMessage));}catch(error){showMessage(authFriendlyError(error),'error');}}));
    const list=byId('chat-list');list.scrollTop=list.scrollHeight;
  }
  const stopMessages = onSnapshot(messages, snapshot => {
    messagesOnScreen = snapshot.docs.map(item => ({ id: item.id, ...item.data() })).reverse();
    paintChat();
  }, error => showMessage(authFriendlyError(error), 'error'));
  const stopPictures = onSnapshot(collection(db, 'profiles'), snapshot => {
    pictures.clear();
    snapshot.docs.forEach(item => pictures.set(item.id, item.data()));
    paintChat();
  }, error => showMessage(authFriendlyError(error), 'error'));
  chatStop = () => { stopMessages(); stopPictures(); };
  byId('chat-form').addEventListener('submit',async event=>{
    event.preventDefault(); const input=byId('chat-text'); const text=input.value.trim();
    if(!text||chatMuted)return;
    try { await addDoc(collection(db,'chat'),{uid:me.uid,nickname:me.nickname,avatar:me.avatar,text,createdAt:serverTimestamp()}); input.value=''; }
    catch(error){showMessage(authFriendlyError(error),'error');}
  });
}

function artRound(now = Date.now()) {
  const shifted = now + 279000000;
  const elapsed = shifted % 604800000;
  return { week: now - elapsed, sunday: elapsed >= 518400000 };
}

async function renderArt() {
  const round = artRound();
  byId('tab-content').innerHTML = '<div class="art-intro"><span aria-hidden="true">🎨</span><div><h3>Art &amp; votes</h3><p></p></div></div><div id="drawing-wall" class="drawing-wall" aria-live="polite"></div>';
  const wall = byId('drawing-wall');
  byId('tab-content').querySelector('.art-intro p').textContent = round.sunday ? '⭐ Voting is open! Pick one favorite.' : '🗓️ Voting opens Sunday (India time).';
  if (!round.sunday && !uploadsDisabled) {
    const draw = document.createElement('button');
    draw.className = 'button button-purple';
    draw.textContent = '✏️ Draw';
    draw.onclick = () => location.assign('doodle.html');
    wall.before(draw);
  }
  try {
    const [arts, votes] = await Promise.all([
      getDocs(query(collection(db, 'weeklyArt'), where('week', '==', round.week))),
      getDocs(query(collection(db, 'artVotes'), where('week', '==', round.week)))
    ]);
    const myVote = votes.docs.find(vote => vote.id === me.uid);
    const counts = new Map();
    for (const vote of votes.docs) {
      const id = vote.data().art;
      counts.set(id, (counts.get(id) || 0) + 1);
    }
    if (arts.empty) wall.textContent = '🖍️ No doodles yet';
    for (const art of arts.docs) {
      const data = art.data();
      const card = document.createElement('article');
      card.className = 'drawing-card';
      const img = document.createElement('img');
      if (/^data:image\/(webp|png);base64,[a-z0-9+/=]+$/i.test(data.strokes)) img.src = data.strokes;
      img.alt = 'Doodle by ' + data.nickname;
      const label = document.createElement('p');
      label.textContent = data.nickname;
      card.append(img, label);
      if (round.sunday) {
        const vote = document.createElement('button');
        vote.className = 'reaction-button';
        vote.textContent = myVote?.data().art === art.id ? '✅ My vote' : data.uid === me.uid ? 'My drawing' : '⭐ Vote';
        vote.setAttribute('aria-label', 'Vote for ' + data.nickname);
        vote.disabled = Boolean(myVote) || data.uid === me.uid;
        vote.onclick = async () => {
          vote.disabled = true;
          try {
            await setDoc(doc(db, 'artVotes', me.uid), { week: round.week, art: art.id });
            if (wall.isConnected) renderArt();
            showMessage('Vote saved! ⭐', 'success');
          } catch (error) {
            vote.disabled = false;
            showMessage(authFriendlyError(error), 'error');
          }
        };
        card.append(vote);
        if (myVote) {
          const total = document.createElement('p');
          total.textContent = '⭐ ' + (counts.get(art.id) || 0);
          card.append(total);
        }
      }
      wall.append(card);
    }
  } catch (error) { wall.textContent = authFriendlyError(error); }
}

async function renderTeam() {
  byId('tab-content').innerHTML=`<div class="team-head-card"><span>🧸</span><div><h3>Team buddies</h3><p>Say hello to your fellow game changers.</p></div></div><div id="team-list" class="team-list"><p class="tiny-note">Loading your team…</p></div>${me.role==='admin'?'<section class="admin-panel"><div class="admin-panel-heading"><span>👑</span><div><h3>Team leader tools</h3><p>Manage helpers and keep the club friendly.</p></div></div><div class="invite-controls"><button class="button button-purple" id="new-invite">Make a new team code</button><button class="reaction-button" id="copy-invite" disabled>Copy join link</button></div><div id="invite-output" class="invite-output"></div><div class="photo-lock">Members can share drawings they make in the club.</div></section>':''}`;
  try {
    const people=await getDocs(collection(db,'profiles'));
    const memberDocs=me.role==='admin'?await getDocs(collection(db,'members')):null;
    const flagMap=memberDocs?Object.fromEntries(memberDocs.docs.map(d=>[d.id,d.data()])):{};
    membersCache=people.docs.map(d=>({id:d.id,...d.data()}));
    byId('team-list').innerHTML=membersCache.length?membersCache.map(person=>{
      const flags=flagMap[person.uid];
      return `<article class="team-person"><span class="feed-avatar">${avatarMarkup(person)}</span><div class="team-person-name"><b>${escapeHtml(person.nickname)}</b><small>@${escapeHtml(person.username)} ${flags?.role==='admin'?'· team admin':''}</small></div>${me.role==='admin'&&person.uid!==me.uid?`<div class="member-controls"><button class="reaction-button" data-member-action="chat" data-uid="${person.uid}">${flags?.chatMuted?'Unpause chat':'Pause chat'}</button><button class="reaction-button" data-member-action="uploads" data-uid="${person.uid}">${flags?.uploadsDisabled?'Allow art':'Pause art'}</button><button class="reaction-button" data-member-action="admin" data-uid="${person.uid}">${flags?.role==='admin'?'Remove admin':'Make admin'}</button><button class="reaction-button danger" data-member-action="remove" data-uid="${person.uid}">Remove</button></div>`:''}</article>`;
    }).join(''):'<p class="empty-chat">Your team is ready for friends to join! 🫶</p>';
    qsa('[data-member-action]').forEach(button=>button.addEventListener('click',()=>manageMember(button.dataset.uid,button.dataset.memberAction,flagMap[button.dataset.uid])));
    if(me.role==='admin') setupInviteControls();
  } catch(error){byId('team-list').innerHTML=`<p class="tiny-note">${escapeHtml(authFriendlyError(error))}</p>`;}
}

async function manageMember(uid, action, flags={}) {
  try {
    if(action==='remove') {
      if(!confirm('Remove this teammate from the club?')) return;
      const batch=writeBatch(db);batch.update(memberRef(uid),{status:'removed'});batch.delete(profileRef(uid));await batch.commit();showMessage('Member removed from the group.','success');
    } else if(action==='chat') {
      await updateDoc(memberRef(uid),{chatMuted:!flags.chatMuted});showMessage(flags.chatMuted?'Chat access restored.':'Chat paused for this member.','success');
    } else if(action==='uploads') {
      await updateDoc(memberRef(uid),{uploadsDisabled:!flags.uploadsDisabled});showMessage(flags.uploadsDisabled?'Doodle sharing restored.':'Art sharing paused for this member.','success');
    } else if(action==='admin') {
      await updateDoc(memberRef(uid),{role:flags.role==='admin'?'member':'admin'});showMessage(flags.role==='admin'?'Admin role removed.':'They are now a team admin.','success');
    }
    await renderTeam();
  } catch(error){showMessage(authFriendlyError(error),'error');}
}

async function setupInviteControls() {
  const newButton=byId('new-invite');
  const copyButton=byId('copy-invite');
  if(!newButton)return;
  const firstInvite=sessionStorage.getItem('igct_invite_' + me.uid);
  if (firstInvite) {
    try {
      const settings = await getDoc(settingsRef());
      if (settings.data()?.inviteHash === await digestText(firstInvite) && newButton.isConnected) {
        showInvite(firstInvite);
      }
    } catch (error) {
      showMessage(authFriendlyError(error), 'error');
    }
  }
  newButton.addEventListener('click',async()=>{
    newButton.disabled=true;
    try {
      const raw=randomInvite(); const hash=await digestText(raw);
      const settings=await getDoc(settingsRef());
      const oldHash=settings.data().inviteHash;
      const batch=writeBatch(db);
      if(oldHash) batch.update(doc(db,'invites',oldHash),{active:false});
      batch.set(doc(db,'invites',hash),{active:true,createdBy:me.uid,createdAt:serverTimestamp()});
      batch.update(settingsRef(),{inviteHash:hash});
      await batch.commit();
      sessionStorage.setItem('igct_invite_' + me.uid, raw);
      showInvite(raw);
    } catch(error){showMessage(authFriendlyError(error),'error');}
    finally{newButton.disabled=false;}
  });
  copyButton.addEventListener('click',async()=>{
    const raw=sessionStorage.getItem('igct_invite_' + me.uid);if(!raw)return;
    const link=`${location.origin}${location.pathname.replace(/club\.html$/,'')}index.html?invite=${encodeURIComponent(raw)}`;
    try{await navigator.clipboard.writeText(link);showMessage('Team join link copied. Turn it into a QR to share!','success');}catch{showMessage(link);}
  });
}
function showInvite(raw) {
  const box=byId('invite-output'); if(!box)return;
  const link=`${location.origin}${location.pathname.replace(/club\.html$/,'')}index.html?invite=${encodeURIComponent(raw)}`;
  box.innerHTML=`<div id="invite-qr" class="invite-qr"></div><div><p>Team code</p><code id="team-code" style="overflow-wrap:anywhere"></code><p>Scan the QR or paste this code on the join page.</p></div><small>Keep this invite for your group. Make a new one if it gets shared outside the team.</small>`;
  byId('team-code').textContent = raw;
  byId('copy-invite').disabled=false;
  if(window.QRCode)new window.QRCode(byId('invite-qr'),{text:link,width:168,height:168,colorDark:'#2c2552',colorLight:'#ffffff',correctLevel:window.QRCode.CorrectLevel.M});
  else byId('invite-qr').textContent='QR helper is loading — use Copy join link.';
}

function renderMe() {
  byId('tab-content').innerHTML = `
    <article class="profile-summary">
      <span id="my-avatar-preview" class="profile-avatar">${avatarMarkup(me)}</span>
      <div><div class="eyebrow">${me.role === 'admin' ? 'TEAM ADMIN' : 'TEAM MEMBER'}</div>
      <h3>${escapeHtml(me.nickname)}</h3><p>@${escapeHtml(me.username)}</p></div>
    </article>
    <form id="profile-photo-form" class="profile-photo-card">
      <h3>📸 Change my picture</h3>
      <label for="profile-photo">Pick a picture from your device</label>
      <input id="profile-photo" type="file" accept="image/jpeg,image/png,image/webp" aria-describedby="profile-photo-hint">
      <small id="profile-photo-hint">Your team can see it. Ask a grown-up before sharing a photo.</small>
      <div class="profile-photo-actions">
        <button class="button button-purple" type="submit" disabled>Save picture</button>
        <button class="reaction-button" id="profile-photo-remove" type="button" ${me.avatarPhoto ? '' : 'hidden'}>Use my default icon</button>
      </div>
      <p id="profile-photo-status" role="status"></p>
    </form>
    <button class="reaction-button" id="profile-signout">Sign out</button>`;

  const form = byId('profile-photo-form');
  const input = byId('profile-photo');
  const preview = byId('my-avatar-preview');
  const status = byId('profile-photo-status');
  const save = form.querySelector('[type="submit"]');
  const remove = byId('profile-photo-remove');
  let pendingPhoto = '';
  let selection = 0;

  input.addEventListener('change', async () => {
    const version = ++selection;
    pendingPhoto = '';
    save.disabled = true;
    remove.disabled = true;
    preview.innerHTML = avatarMarkup(me);
    status.textContent = '';
    try {
      const file = input.files[0];
      if (!file) return;
      status.textContent = 'Preparing your picture…';
      const photo = await makeAvatar(file);
      if (version !== selection || !form.isConnected) return;
      pendingPhoto = photo;
      preview.innerHTML = avatarMarkup({ ...me, avatarPhoto: photo });
      status.textContent = 'Looks good? Tap Save picture.';
      save.disabled = false;
    } catch (error) {
      if (version === selection) status.textContent = error instanceof DOMException ? 'Could not open that image.' : error.message;
    } finally {
      if (version === selection) remove.disabled = false;
    }
  });

  async function savePicture(photo) {
    const profile = me;
    input.disabled = save.disabled = remove.disabled = true;
    status.textContent = 'Saving…';
    try {
      await updateDoc(profileRef(profile.uid), { avatarPhoto: photo || deleteField() });
      if (photo) profile.avatarPhoto = photo;
      else delete profile.avatarPhoto;
      if (me === profile) byId('club-avatar').innerHTML = avatarMarkup(me);
      if (form.isConnected) {
        pendingPhoto = '';
        input.value = '';
        preview.innerHTML = avatarMarkup(profile);
        remove.hidden = !photo;
        status.textContent = 'Picture saved! ✨';
      }
    } catch (error) {
      status.textContent = error.code === 'permission-denied'
        ? 'Picture saving is blocked. Ask an admin to check Firebase.'
        : authFriendlyError(error);
    } finally {
      input.disabled = remove.disabled = false;
      save.disabled = !pendingPhoto;
    }
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    if (pendingPhoto && !input.disabled) savePicture(pendingPhoto);
  });
  remove.addEventListener('click', () => savePicture(''));
  byId('profile-signout').addEventListener('click', async () => {
    await signOut(auth);
    location.assign('index.html');
  });
}

function selectTab(name) {
  activeTab = name;
  if (stopDailyScore) { stopDailyScore(); stopDailyScore = null; }
  if(chatStop){chatStop();chatStop=null;}
  qsa('.nav-item').forEach(item=>item.classList.toggle('active',item.dataset.tab===name));
  byId('section-title').textContent=({home:'Team home',games:'Group games',chat:'Team chat',art:'Art corner',team:'Team buddies',me:'My profile'})[name]||'Team home';
  if(name==='home')renderHome();
  if(name==='games')renderGames();
  if(name==='chat')renderChat();
  if(name==='art')renderArt();
  if(name==='team')renderTeam();
  if(name==='me')renderMe();
}

const clubPage=byId('tab-content');
if(clubPage){
  onAuthStateChanged(auth,async user=>{
    if(!user){location.replace('login.html');return;}
    try{
      const memberSnap=await getDoc(memberRef(user.uid));
      const profileSnap=await getDoc(profileRef(user.uid));
      if(!memberSnap.exists()||memberSnap.data().status!=='active'||!profileSnap.exists()){
        await signOut(auth);location.replace('login.html');return;
      }
      me={uid:user.uid,...memberSnap.data(),...profileSnap.data()};
      chatMuted=Boolean(me.chatMuted);uploadsDisabled=Boolean(me.uploadsDisabled);
      byId('greeting').textContent=`Hey, ${me.nickname}!`;
      byId('club-avatar').innerHTML = avatarMarkup(me);
      selectTab(['games','art'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'home');
      onSnapshot(memberRef(user.uid), snapshot => {
        const flags = snapshot.data();
        if (!flags || flags.status !== 'active') {
          signOut(auth).catch(() => location.replace('login.html'));
          return;
        }
        const changed = me.role !== flags.role || chatMuted !== flags.chatMuted || uploadsDisabled !== flags.uploadsDisabled;
        me.role = flags.role;
        chatMuted = flags.chatMuted;
        uploadsDisabled = flags.uploadsDisabled;
        if (changed) selectTab(activeTab);
      }, error => showMessage(authFriendlyError(error), 'error'));
      qsa('.nav-item').forEach(item=>item.addEventListener('click',event=>{event.preventDefault();selectTab(item.dataset.tab);}));
      byId('logout')?.addEventListener('click',async()=>{await signOut(auth);location.assign('index.html');});
    }catch(error){showMessage(authFriendlyError(error),'error');}
  });
}





const studioCanvas = byId('studio-canvas');
if (studioCanvas) {
  onAuthStateChanged(auth, async user => {
    if (!user) return location.replace('login.html');
    try {
      const [membership, profile] = await Promise.all([getDoc(memberRef(user.uid)), getDoc(profileRef(user.uid))]);
      if (membership.data()?.status !== 'active' || !profile.exists()) return location.replace('login.html');
      me = { ...profile.data(), uid: user.uid };
      uploadsDisabled = membership.data().uploadsDisabled;
      byId('studio-tools').disabled = false;
      byId('save-doodle').disabled = false;
      const prompts = ['a silly robot', 'a magical lunchbox', 'a happy dragon', 'a dream treehouse'];
      byId('studio-prompt').textContent = 'Draw ' + prompts[Number(todayInIndia().slice(-2)) % prompts.length];
      setupDrawingTools(studioCanvas);
      setupStudioShare(studioCanvas);
    } catch (error) { showMessage(authFriendlyError(error), 'error'); }
  });
}
function setupStudioShare(canvas) {
  byId('save-doodle').addEventListener('click', async () => {
    if (uploadsDisabled) return showMessage('Your drawing permission is paused by the admin.', 'error');
    const button=byId('save-doodle'); button.disabled=true;
    try {
      const png=canvas.toDataURL('image/webp',0.5);
      if(png.length>800000) throw new Error('DRAWING_TOO_LARGE');
      const round = artRound();
      if (round.sunday) throw new Error('VOTE_DAY');
      const art = doc(collection(db, 'weeklyArt'));
      const slot = doc(db, 'artSlots', me.uid);
      await runTransaction(db, async tx => {
        const previous = await tx.get(slot);
        if (previous.data()?.week === round.week) throw new Error('ART_LIMIT');
        tx.set(slot, { week: round.week, art: art.id });
        tx.set(art, { uid: me.uid, nickname: me.nickname, strokes: png, week: round.week });
      });
      button.dataset.shared = 'yes'; showMessage('Doodle shared with your team! 🎨','success');
    } catch(error) { showMessage(error.message==='ART_LIMIT'?'One doodle each week!':error.message==='VOTE_DAY'?'Sunday is for voting!':error.message==='DRAWING_TOO_LARGE'?'Try a simpler drawing and share again.':authFriendlyError(error),'error'); }
    finally { button.disabled = button.dataset.shared === "yes"; }
  });
}





