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
import { setupDrawingTools } from './drawing.js?v=8';
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
  const joinPassword = byId('join-password').value.trim();
  if (!invite && !joinPassword) return writeFormError('join-error', 'Enter your team invite code, or open Creating a new team? to use the creation password.');
  if (nickname.length < 2) return writeFormError('join-error', 'Choose a nickname with at least two characters.');
  if (!validUsername(username)) return writeFormError('join-error', 'Use 3–16 letters, numbers, or underscores in your username.');
  if (!/^\d{4}$/.test(pin)) return writeFormError('join-error', 'Your PIN needs to be exactly four numbers.');
  if (pin !== pinAgain) return writeFormError('join-error', 'Those PINs do not match. Try again!');
  if (!byId('adult-check').checked) return writeFormError('join-error', 'Please ask a trusted grown-up to help you join.');
  const button = event.submitter;
  button.disabled = true;
  button.textContent = 'Setting up your team buddy…';
  let credential;
  let created = false;
  try {
    const accountPassword = await pinPassword(username, pin);
    try {
      credential = await createUserWithEmailAndPassword(auth, pseudoEmail(username), accountPassword);
      created = true;
    } catch (error) {
      if (error.code !== 'auth/email-already-in-use') throw error;
      try {
        credential = await signInWithEmailAndPassword(auth, pseudoEmail(username), accountPassword);
      } catch (signInError) {
        if (signInError.code === 'auth/invalid-credential') throw error;
        throw signInError;
      }
    }
    const uid = credential.user.uid;
    let result;
    if (invite) {
      const inviteProof = await digestText(invite);
      await runTransaction(db, async tx => {
        const membership = await tx.get(memberRef(uid));
        if (membership.exists()) {
          if (membership.data().status !== 'active') throw new Error('MEMBERSHIP_REMOVED');
          return;
        }
        const ticket = await tx.get(doc(db, 'invites', inviteProof));
        if (ticket.data()?.active !== true) throw new Error('BAD_INVITE');
        const createdAt = serverTimestamp();
        tx.set(memberRef(uid), { uid, role: 'member', status: 'active', chatMuted: false,
          uploadsDisabled: false, inviteProof, createdAt });
        tx.set(profileRef(uid), { uid, username, nickname, avatar: '🦊', createdAt });
      });
      result = {};
    } else {
      result = await callClubFunction('registerClubMember', { username, nickname, password: joinPassword, invite: '' });
    }
    if (result.invite) {
      try { sessionStorage.setItem('igct_invite_' + credential.user.uid, result.invite); }
      catch { /* The admin can generate a new invite if local storage is blocked. */ }
    }
    location.assign('club.html');
  } catch (error) {
    const rejected = ['functions/invalid-argument', 'functions/permission-denied',
      'functions/failed-precondition', 'functions/resource-exhausted'].includes(error.code);
    if (created && credential && (rejected || error.message === 'BAD_INVITE' || (invite && error.code === 'permission-denied'))) {
      try { await deleteUser(credential.user); } catch { /* A later retry can recover the login. */ }
    }
    if (credential && auth.currentUser?.uid === credential.user.uid) {
      try { await signOut(auth); } catch { /* The member rules still protect the club. */ }
    }
    const message = error.message === 'BAD_INVITE' ? 'That invite code expired or is incorrect. Ask for a fresh code.'
      : error.message === 'MEMBERSHIP_REMOVED' ? 'This account is no longer a team member. Ask your admin for help.'
      : invite && error.code === 'permission-denied' ? 'This invite could not be accepted. Ask your admin for a fresh code or to check the Firebase rules.'
      : rejected ? error.message
      : String(error.code).startsWith('functions/') ? 'Registration is unavailable. Ask your club admin to check the Firebase setup.'
      : authFriendlyError(error);
    writeFormError('join-error', message);
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
  const step = 2 + dailyNumber % 5;
  const first = 1 + dailyNumber % 4;
  const puzzleAnswer = first + step * 3;
  const card = byId('tab-content');
  card.innerHTML = `<div class="games-grid">
    <article class="game-card trivia-game"><div class="game-top"><span>🧠</span><small>TEAM TRIVIA</small><b>+5 ⭐</b></div><h3>Quick Brain Boost</h3><p class="game-question">${question.q}</p><div class="answer-list">${question.options.map(option => `<button class="answer-choice" data-answer="${escapeHtml(option)}">${escapeHtml(option)}</button>`).join('')}</div></article>
    <article class="game-card mission-game"><div class="game-top"><span>💜</span><small>KINDNESS QUEST</small><b>+3 ⭐</b></div><h3>Today's kind mission</h3><p class="game-question">${mission}</p><button class="button button-purple full-button" id="mission-done">I did it! 🎉</button><p class="tiny-note">Do this in real life, then come back to collect your stars.</p></article>
    <article class="game-card"><h3>🎨 Doodle of the day</h3><a class="button button-purple" href="doodle.html">Try today’s doodle →</a></article>
    <article class="game-card"><h3>🔢 Number Quest <small>+4 ⭐</small></h3><p>What is ${dailyNumber} + 6?</p><div class="answer-list">${[dailyNumber + 5, dailyNumber + 7, dailyNumber + 6].sort((a,b) => (a % 3) - (b % 3)).map(n => `<button type="button" class="answer-choice" data-number="${n}">${n}</button>`).join('')}</div></article>
    <article class="game-card"><h3>💜 Kind Choice <small>+2 ⭐</small></h3><p>A teammate drops their pencils. What could you do?</p><div class="answer-list"><button class="answer-choice" data-kind="yes">Help pick them up</button><button class="answer-choice" data-kind="no">Walk past them</button></div></article>
    <article class="game-card puzzle-card"><div class="puzzle-top"><span aria-hidden="true">🧩</span><h3>Daily Puzzle</h3><b>+3 ⭐</b></div>
      <p>Tap the next number.</p><div class="puzzle-sequence" aria-label="${first}, ${first + step}, ${first + step * 2}, what comes next?"><span>${first}</span><span>${first + step}</span><span>${first + step * 2}</span><strong>?</strong></div>
      <div class="answer-list">${[puzzleAnswer - 1, puzzleAnswer, puzzleAnswer + 1]
        .sort((a,b) => (a % 3) - (b % 3))
        .map(n => `<button class="answer-choice" data-puzzle="${n}">${n}</button>`).join('')}</div>
    </article>
    <article class="game-card stars-game"><div class="game-top"><span>🏆</span><small>TEAM STARS</small><b>Leaderboard</b></div><h3>Cheer each other on</h3><div id="score-list" class="score-list"><p class="tiny-note">Loading team stars…</p></div></article>
  </div>`;
  const gameView = card.firstElementChild;
  const tasks = [
    { id: 'trivia', points: 5, buttons: qsa('[data-answer]', card), correct: button => button.dataset.answer === question.a },
    { id: 'kindness', points: 3, buttons: [byId('mission-done')], correct: () => true },
    { id: 'math', points: 4, buttons: qsa('[data-number]', card), correct: button => Number(button.dataset.number) === dailyNumber + 6 },
    { id: 'puzzle', points: 3, buttons: qsa('[data-puzzle]', card), correct: button => Number(button.dataset.puzzle) === puzzleAnswer },
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

  byId('tab-content').innerHTML=`<section class="chat-panel"><header class="chat-top"><button class="reaction-button" id="close-chat">← Club</button><strong>💬 Team chat</strong><button class="reaction-button" id="open-polls">📊 Polls</button></header><section id="poll-panel" hidden></section><div class="chat-guidelines">💬 Be kind 💜 Keep personal details private.</div><div id="chat-list" class="chat-list"><p class="tiny-note">Loading team chat…</p></div><form id="chat-form" class="chat-form"><label class="sr-only" for="chat-text">Write a kind team message</label><input id="chat-text" maxlength="350" placeholder="Write a kind team message…" ${chatMuted?'disabled':''} required><button class="button button-purple" type="submit" ${chatMuted?'disabled':''}>Send ✨</button></form>${chatMuted?'<p class="muted-notice">🔒 Chat paused</p>':''}</section>`;
  byId('close-chat').onclick = () => selectTab('home');
  byId('open-polls').onclick = togglePolls;
  if(chatStop) chatStop();
  const messages=query(collection(db,'chat'),orderBy('createdAt','desc'),limit(35));
  const listView = byId("chat-list");
  function paintChat() {
    if (!listView.isConnected) return;
    const items = messagesOnScreen;
    byId('chat-list').innerHTML=items.length?items.map(item=>`<article class="chat-message ${item.uid === me.uid ? 'chat-mine' : ''} ${item.admin === true ? 'chat-admin' : ''}"><span class="feed-avatar">${avatarMarkup(pictures.get(item.uid) || item)}</span><div class="chat-message-body"><div><b>${escapeHtml(item.nickname||'Team friend')}</b><small>${item.uid===me.uid?'you':''}</small></div><p>${escapeHtml(item.text)}</p>${me.role==='admin'?`<button class="tiny-admin-action" data-delete-message="${item.id}">Remove message</button>`:''}</div></article>`).join(''):'<p class="empty-chat">No messages yet. Say a kind hello! 👋</p>';
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
    try { await addDoc(collection(db,'chat'),{uid:me.uid,nickname:me.nickname,avatar:me.avatar,admin:me.role==='admin',text,createdAt:serverTimestamp()}); input.value=''; }
    catch(error){showMessage(authFriendlyError(error),'error');}
  });
}

// A round starts on Sunday. Use the following Monday as its key
// so existing Monday-keyed drawings stay in their current round.
function artRound(now = Date.now()) {
  return { week: now + 86400000 - (now + 365400000) % 604800000 };
}

async function saveWeeklyDrawing(strokes, week) {
  const slots = Array.from({ length: 5 }, (_, index) => doc(db, 'weeklyArt', `${me.uid}_${week}_${index}`));
  await runTransaction(db, async tx => {
    const legacy = await tx.get(doc(db, 'artSlots', me.uid));
    const oldArt = legacy.data()?.week === week ? await tx.get(doc(db, 'weeklyArt', legacy.data().art)) : null;
    const snapshots = await Promise.all(slots.map(slot => tx.get(slot)));
    const open = snapshots.findIndex((snapshot, index) => !snapshot.exists() && (index !== 0 || !oldArt?.exists()));
    if (open < 0) throw new Error('ART_LIMIT');
    tx.set(slots[open], { uid: me.uid, nickname: me.nickname, strokes, week, slot: open });
  });
}

async function renderArt() {
  const { week } = artRound();
  byId('tab-content').innerHTML = `
    <div class="art-intro"><span aria-hidden="true">🎨</span><div><h3>Art Corner</h3>
    <p>5 drawings · 10 votes · Results on Sunday</p><p id="art-vote-count"></p></div></div>
    <section id="art-podium" class="art-podium" aria-label="Art winners"></section>
    <div id="drawing-wall" class="drawing-wall"></div>
    <dialog id="drawing-preview"><button type="button" class="reaction-button">Close ✕</button><img alt=""></dialog>`;
  const wall = byId('drawing-wall');
  const status = byId('art-vote-count');
  loadArtPodium(byId('art-podium'));
  const viewer = byId('drawing-preview');
  viewer.querySelector('button').onclick = () => viewer.close();
  if (!uploadsDisabled) wall.insertAdjacentHTML('beforebegin', '<a class="button button-purple" href="doodle.html">✏️ Draw</a>');
  const voteRef = doc(db, 'weeklyBallots', `${me.uid}_${week}`);
  try {
    const [arts, ballot] = await Promise.all([
      getDocs(query(collection(db, 'weeklyArt'), where('week', '==', week))),
      getDoc(voteRef)
    ]);
    if (!wall.isConnected) return;
    const myVotes = ballot.data()?.choices || {};
    const count = Object.keys(myVotes).length;
    status.textContent = `${count}/10 votes used · Edit votes until the round closes Sunday at 12 a.m. IST`;
    if (arts.empty) wall.textContent = '🖍️ No doodles yet';
    let busy = false;
    async function changeVote(id, removeOnly = false) {
      if (busy) return;
      busy = true;
      try {
        await runTransaction(db, async tx => {
          const live = await tx.get(voteRef);
          const choices = { ...live.data()?.choices };
          if (choices[id]) delete choices[id];
          else if (removeOnly) return;
          else if (Object.keys(choices).length < 10) choices[id] = true;
          else throw new Error('VOTE_LIMIT');
          tx.set(voteRef, { uid: me.uid, week, choices, target: id });
        });
        showMessage('Votes updated! ⭐', 'success');
        if (wall.isConnected) renderArt();
      } catch (error) {
        showMessage(error.message === 'VOTE_LIMIT' ? 'Undo a vote before adding another.' : authFriendlyError(error), 'error');
      } finally { busy = false; }
    }
    {
      const visible = new Set(arts.docs.map(art => art.id));
      for (const id of Object.keys(myVotes).filter(id => !visible.has(id))) {
        const remove = document.createElement('button');
        remove.className = 'reaction-button';
        remove.textContent = 'Undo vote for removed drawing';
        remove.onclick = () => changeVote(id, true);
        wall.before(remove);
      }
    }
    for (const art of arts.docs) {
      const data = art.data();
      if (!/^data:image\/(webp|png);base64,[a-z0-9+/=]+$/i.test(data.strokes)) continue;
      const card = document.createElement('article');
      card.className = 'drawing-card';
      const image = document.createElement('img');
      image.src = data.strokes;
      image.alt = 'Doodle by ' + data.nickname;
      image.loading = 'lazy';
      const name = document.createElement('p');
      name.textContent = data.nickname;
      const view = document.createElement('button');
      view.className = 'reaction-button';
      view.textContent = 'View';
      view.onclick = () => {
        const largeImage = viewer.querySelector('img');
        largeImage.src = image.src;
        largeImage.alt = image.alt;
        viewer.showModal();
      };
      const download = document.createElement('a');
      download.className = 'reaction-button';
      download.href = data.strokes;
      download.download = `igct-doodle.${data.strokes.startsWith('data:image/webp') ? 'webp' : 'png'}`;
      download.textContent = 'Download';
      const controls = document.createElement('div');
      controls.className = 'art-actions';
      controls.append(view, download);
      const vote = document.createElement('button');
      vote.className = 'reaction-button';
      vote.textContent = myVotes[art.id] ? '✓ Undo vote' : '⭐ Vote';
      vote.disabled = data.uid === me.uid || (count >= 10 && !myVotes[art.id]);
      vote.onclick = () => changeVote(art.id);
      controls.append(vote);
      if (data.uid === me.uid || me.role === 'admin') {
        const remove = document.createElement('button');
        remove.className = 'reaction-button';
        remove.textContent = 'Delete';
        remove.onclick = async () => {
          if (busy || !confirm('Delete this doodle and its entry in the contest?')) return;
          busy = true;
          try { await deleteDoc(art.ref); if (wall.isConnected) renderArt(); }
          catch (error) { showMessage(authFriendlyError(error), 'error'); }
          finally { busy = false; }
        };
        controls.append(remove);
      }
      card.append(image, name, controls);
      wall.append(card);
    }
  } catch (error) { wall.textContent = authFriendlyError(error); }
}

async function loadArtPodium(panel) {
  try {
    const rounds = await getDocs(query(collection(db, 'artResults'), orderBy('week', 'desc'), limit(12)));
    if (!panel.isConnected || rounds.empty) return;
    const ranked = rounds.docs.filter(round => Array.isArray(round.data().podium));
    if (!ranked.length) return;
    panel.innerHTML = '<h3>🏆 Sunday results</h3><label>Round <select aria-label="Results round"></select></label><div class="drawing-wall"></div>';
    const selector = panel.querySelector('select');
    const gallery = panel.querySelector('.drawing-wall');
    const labels = ['🥇 Winner', '🥈 Runner-up', '🥉 Second runner-up'];
    const formatter = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
    for (const round of ranked) {
      selector.add(new Option(formatter.format(round.data().week + 518400000), round.id));
    }
    async function paint() {
      const selected = selector.value;
      const round = ranked.find(item => item.id === selected);
      const podium = round.data().podium;
      gallery.textContent = podium.length ? 'Loading winners…' : 'No votes in this round.';
      const drawings = await Promise.all(podium.map(place => getDoc(doc(db, 'weeklyArt', place.artId))));
      if (!gallery.isConnected || selector.value !== selected || !podium.length) return;
      gallery.replaceChildren();
      podium.forEach((place, index) => {
        const card = document.createElement('article');
        card.className = 'drawing-card podium-card';
        const title = document.createElement('strong');
        title.textContent = labels[index];
        const detail = document.createElement('p');
        detail.textContent = `${place.nickname} · ${place.stars} ⭐ · ${place.votes} votes`;
        card.append(title, detail);
        const strokes = drawings[index].data()?.strokes;
        if (typeof strokes === 'string' && /^data:image\/(webp|png);base64,[a-z0-9+/=]+$/i.test(strokes)) {
          const image = document.createElement('img');
          image.src = strokes;
          image.alt = labels[index] + ' drawing by ' + place.nickname;
          card.append(image);
        }
        gallery.append(card);
      });
    }
    function showRound() {
      paint().catch(() => { if (gallery.isConnected) gallery.textContent = 'Could not load these drawings.'; });
    }
    selector.addEventListener('change', showRound);
    showRound();
  } catch {
    if (panel.isConnected) panel.textContent = 'Sunday results will appear here after the weekly tally.';
  }
}

async function togglePolls() {
  const panel = byId('poll-panel');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) await renderPolls(panel);
}

async function renderPolls(panel) {
  panel.innerHTML = '<h3>Team polls</h3><div id="poll-list"></div>';
  const list = panel.querySelector('#poll-list');
  if (me.role === 'admin') {
    panel.insertAdjacentHTML('beforeend', `<form class="poll-form"><label>Question <input name="question" maxlength="100" required></label>
      <label>Choice 1 <input name="first" maxlength="40" required></label>
      <label>Choice 2 <input name="second" maxlength="40" required></label><button class="reaction-button">Create poll</button></form>`);
    panel.querySelector('form').onsubmit = async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const fields = new FormData(form);
      const [question, first, second] = ['question', 'first', 'second'].map(key => fields.get(key).trim());
      if (!question || !first || !second || first.toLowerCase() === second.toLowerCase()) return showMessage('Enter a question and two different choices.');
      const submit = form.querySelector('button');
      submit.disabled = true;
      try {
        await addDoc(collection(db, 'teamPolls'), { question, first, second, createdAt: serverTimestamp() });
        if (panel.isConnected) renderPolls(panel);
      } catch (error) { showMessage(authFriendlyError(error), 'error'); }
      finally { submit.disabled = false; }
    };
  }
  try {
    const polls = await getDocs(query(collection(db, 'teamPolls'), orderBy('createdAt', 'desc'), limit(5)));
    if (!list.isConnected) return;
    if (polls.empty) list.textContent = 'No polls yet.';
    const cards = await Promise.all(polls.docs.map(async poll => {
      const replies = await getDocs(collection(poll.ref, 'answers'));
      const choices = [poll.data().first, poll.data().second];
      const mine = replies.docs.find(reply => reply.id === me.uid)?.data().option;
      const card = document.createElement('article');
      const title = document.createElement('strong');
      title.textContent = poll.data().question;
      card.append(title);
      choices.forEach((choice, option) => {
        const button = document.createElement('button');
        button.className = 'reaction-button';
        button.textContent = `${mine === option ? '✓ ' : ''}${choice} · ${replies.docs.filter(reply => reply.data().option === option).length}`;
        button.onclick = async () => {
          button.disabled = true;
          try { await setDoc(doc(poll.ref, 'answers', me.uid), { option }); if (list.isConnected) renderPolls(panel); }
          catch (error) { showMessage(authFriendlyError(error), 'error'); }
          finally { button.disabled = false; }
        };
        card.append(button);
      });
      return card;
    }));
    if (list.isConnected) list.append(...cards);
  } catch (error) { list.textContent = authFriendlyError(error); }
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
      return `<article class="team-person"><span class="feed-avatar">${avatarMarkup(person)}</span><div class="team-person-name"><b>${escapeHtml(person.nickname)}</b><small>@${escapeHtml(person.username)} ${flags?.role==='admin'?'· team admin':''}</small></div>${me.role==='admin'&&person.uid!==me.uid?`<div class="member-controls"><button class="reaction-button" data-member-action="chat" data-uid="${person.uid}">${flags?.chatMuted?'Unpause chat':'Pause chat'}</button><button class="reaction-button" data-member-action="uploads" data-uid="${person.uid}">${flags?.uploadsDisabled?'Allow art':'Pause art'}</button><button class="reaction-button" data-member-action="admin" data-uid="${person.uid}">${flags?.role==='admin'?'Remove admin':'Make admin'}</button><button class="reaction-button" data-member-action="reset" data-uid="${person.uid}">🔑 Allow PIN reset</button><button class="reaction-button danger" data-member-action="remove" data-uid="${person.uid}">Remove</button></div>`:''}</article>`;
    }).join(''):'<p class="empty-chat">Your team is ready for friends to join! 🫶</p>';
    qsa('[data-member-action]').forEach(button=>button.addEventListener('click',()=>button.dataset.memberAction === 'reset' ? issueResetCode(button) : manageMember(button.dataset.uid,button.dataset.memberAction,flagMap[button.dataset.uid])));
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
  document.body.classList.toggle('chat-fullscreen', name === 'chat');
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
      await saveWeeklyDrawing(png, round.week);
      button.dataset.shared = 'yes';
      button.textContent = '✅ Doodle shared!';
      byId('studio-share-status').textContent = 'Your doodle is in Art Corner!';
      showMessage('Doodle shared successfully! 🎉', 'success');
    } catch(error) { showMessage(error.message==='ART_LIMIT'?'You have 5 drawings. Delete one in Art Corner first.':error.message==='DRAWING_TOO_LARGE'?'Try a simpler drawing and share again.':authFriendlyError(error),'error'); }
    finally { button.disabled = button.dataset.shared === "yes"; }
  });
}









async function callClubFunction(name, data) {
  const { getFunctions, httpsCallable } = await import('https://www.gstatic.com/firebasejs/13.4.0/firebase-functions.js');
  return (await httpsCallable(getFunctions(firebaseApp, 'asia-south1'), name)(data)).data;
}

async function issueResetCode(button) {
  button.disabled = true;
  try {
    const result = await callClubFunction('allowPinReset', { uid: button.dataset.uid });
    if (!button.isConnected) return;
    const person = membersCache.find(item => item.uid === button.dataset.uid);
    const dialog = document.createElement('dialog');
    dialog.className = 'pin-code-dialog';
    dialog.innerHTML = '<h2>PIN reset code</h2><p class="code-user"></p><p>Give this privately to your teammate. It works once and expires in 15 minutes.</p><code></code><div class="profile-photo-actions"><button class="button button-purple" type="button">Copy code</button><form method="dialog"><button class="reaction-button">Close</button></form></div>';
    dialog.querySelector('.code-user').textContent = person ? '@' + person.username : '';
    dialog.querySelector('code').textContent = result.code;
    dialog.querySelector('[type="button"]').onclick = async event => {
      const copy = event.currentTarget;
      try { await navigator.clipboard.writeText(result.code); copy.textContent = '✓ Copied'; }
      catch { copy.textContent = 'Select the code to copy'; }
    };
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    document.body.append(dialog);
    dialog.showModal();
  } catch (error) {
    const message = ['functions/permission-denied','functions/failed-precondition','functions/aborted'].includes(error.code)
      ? error.message : 'Could not create the reset code. Ask the club owner to check the reset service.';
    showMessage(message, 'error');
  } finally { button.disabled = false; }
}

const forgotPin = byId('forgot-pin');
if (forgotPin) {
  const panel = byId('pin-recovery');
  const check = byId('pin-reset-check');
  const finish = byId('pin-reset-finish');
  const userField = byId('recovery-username');
  const codeField = byId('recovery-code');
  const status = byId('pin-recovery-status');
  let verified;

  forgotPin.onclick = () => {
    panel.hidden = !panel.hidden;
    forgotPin.setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) {
      userField.value ||= byId('username').value;
      (verified ? byId('recovery-pin') : userField).focus();
    }
  };
  function clearApproval() {
    verified = null;
    finish.reset();
    finish.hidden = true;
  }
  check.addEventListener('input', clearApproval);
  check.addEventListener('submit', async event => {
    event.preventDefault();
    clearApproval();
    const username = cleanUsername(userField.value).replace(/^@/, '');
    const code = codeField.value.trim();
    const button = check.querySelector('button');
    userField.disabled = codeField.disabled = button.disabled = true;
    status.textContent = 'Checking your code…';
    try {
      await callClubFunction('checkPinReset', { username, code });
      verified = { username, code };
      finish.hidden = false;
      status.textContent = 'Your admin approved this reset. Choose a new PIN.';
      byId('recovery-pin').focus();
    } catch (error) {
      status.textContent = error.code === 'functions/failed-precondition'
        ? 'Ask your admin friend to allow a reset and give you a fresh code.'
        : 'Could not check the code. Try again or ask your admin friend for help.';
    } finally { userField.disabled = codeField.disabled = button.disabled = false; }
  });
  finish.addEventListener('submit', async event => {
    event.preventDefault();
    const approval = verified;
    const pin = byId('recovery-pin').value;
    if (!approval) return;
    if (!/^\d{4}$/.test(pin) || pin !== byId('recovery-confirm').value) {
      status.textContent = 'Enter the same four digits in both boxes.';
      return;
    }
    const button = finish.querySelector('button');
    const checkButton = check.querySelector('button');
    button.disabled = checkButton.disabled = userField.disabled = codeField.disabled = true;
    status.textContent = 'Saving your new PIN…';
    try {
      const password = await pinPassword(approval.username, pin);
      await callClubFunction('finishPinReset', { ...approval, password });
      clearApproval();
      check.reset();
      byId('username').value = approval.username;
      byId('pin').value = '';
      status.textContent = '✅ PIN saved! Sign in above with your new PIN.';
    } catch (error) {
      clearApproval();
      status.textContent = error.code === 'functions/failed-precondition'
        ? 'This code expired or was used. Ask your admin friend for a new one.'
        : 'Try signing in with the new PIN. If it fails, ask your admin for a fresh code.';
    } finally { button.disabled = checkButton.disabled = userField.disabled = codeField.disabled = false; }
  });
}





