const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const crypto = require('crypto');
initializeApp();
const db = getFirestore();
const COINS_START = 50;
const durations = new Set([30, 60, 180, 300]);
function requireUser(req) { if (!req.auth) throw new HttpsError('unauthenticated', 'Please sign in first.'); return req.auth.uid; }
function roundInfo(duration, now = Date.now()) { const bucket = Math.floor(now / (duration * 1000)); const start = bucket * duration * 1000; return { id: `${duration}_${bucket}`, duration, startAt: start, endsAt: start + duration * 1000 }; }
function resultColor(n) { if ([0,5].includes(n)) return 'Violet'; if ([1,3,7,9].includes(n)) return 'Green'; return 'Red'; }
function winFor(pick, n) { const p = String(pick); if (/^[0-9]$/.test(p)) return Number(p) === n; if (p === 'Big') return n >= 5; if (p === 'Small') return n <= 4; return p === resultColor(n); }
function resultPayout(pick, amount, n) {
  // Returned value is NET profit (stake was already deducted).
  const p = String(pick); if (!winFor(p, n)) return -amount;
  if (/^[0-9]$/.test(p)) return amount * 7; // net profit; stake was already deducted
  if (p === 'Green') return amount;
  if (p === 'Red') return amount;
  if (p === 'Violet') return amount * 3;
  return amount; // Big/Small: 1:1 net profit
}
async function isAdmin(uid) { const s = await db.doc(`admins/${uid}`).get(); return s.exists && s.get('enabled') === true; }
async function ensureUser(uid, displayName, email) {
  const ref = db.doc(`users/${uid}`);
  await db.runTransaction(async tx => { const s = await tx.get(ref); if (!s.exists) tx.create(ref, { displayName: String(displayName || 'Demo Player').slice(0,60), email: String(email || '').slice(0,200), coins: COINS_START, bonusClaimed: false, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }); else tx.update(ref, { updatedAt: FieldValue.serverTimestamp() }); });
  return ref;
}
exports.ensureProfile = onCall(async req => {
  const uid = requireUser(req); await ensureUser(uid, req.data?.displayName, req.auth.token.email); return { ok: true };
});
exports.claimBonus = onCall(async req => {
  const uid = requireUser(req); const ref = await ensureUser(uid, '', req.auth.token.email); let claimed = false;
  await db.runTransaction(async tx => { const s = await tx.get(ref); if (!s.exists) throw new HttpsError('not-found','Profile missing.'); if (!s.get('bonusClaimed')) { tx.update(ref, { coins: (s.get('coins') || 0) + 50, bonusClaimed: true, updatedAt: FieldValue.serverTimestamp() }); tx.set(ref.collection('ledger').doc(), { type:'bonus', label:'Starter bonus', delta:50, createdAt:FieldValue.serverTimestamp() }); claimed = true; } }); return { claimed };
});
exports.placeBet = onCall(async req => {
  const uid = requireUser(req); const duration = Number(req.data?.duration), amount = Number(req.data?.amount), pick = String(req.data?.pick ?? ''), suppliedRound = String(req.data?.roundId ?? '');
  if (!durations.has(duration)) throw new HttpsError('invalid-argument','Invalid round duration.');
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 10000) throw new HttpsError('invalid-argument','Bet amount must be 1–10000 virtual coins.');
  const validPick = /^(?:[0-9]|Red|Green|Violet|Big|Small)$/.test(pick); if (!validPick) throw new HttpsError('invalid-argument','Choose a valid number, colour, Big or Small.');
  const now = Date.now(), ri = roundInfo(duration, now); if (suppliedRound !== ri.id || now >= ri.endsAt) throw new HttpsError('failed-precondition','Round ended. Refresh and place your bet in the next round.');
  const userRef = await ensureUser(uid, '', req.auth.token.email); const betRef = userRef.collection('bets').doc();
  await db.runTransaction(async tx => { const u = await tx.get(userRef); const coins = Number(u.get('coins') || 0); if (coins < amount) throw new HttpsError('failed-precondition','Not enough virtual coins.'); tx.update(userRef,{coins:coins-amount,updatedAt:FieldValue.serverTimestamp()}); tx.create(betRef,{roundId:ri.id,duration,pick,amount,status:'pending',profit:null,result:null,roundEndsAt:Timestamp.fromMillis(ri.endsAt),createdAt:FieldValue.serverTimestamp()}); tx.set(userRef.collection('ledger').doc(),{type:'bet',label:`Bet: ${pick}`,delta:-amount,betId:betRef.id,createdAt:FieldValue.serverTimestamp()}); }); return { ok:true, betId:betRef.id };
});
async function settleDueBets(uid) {
  const userRef = db.doc(`users/${uid}`); const betsSnap = await userRef.collection('bets').where('status','==','pending').limit(100).get();
  for (const betDoc of betsSnap.docs) {
    const bet = betDoc.data(); const endMs = bet.roundEndsAt?.toMillis?.() || 0; if (endMs > Date.now()) continue;
    const roundRef = db.doc(`rounds/${bet.roundId}`);
    // One result per round. Result is created only after the round closes.
    let resultDoc = await roundRef.get();
    if (!resultDoc.exists) {
      await db.runTransaction(async tx => { const s = await tx.get(roundRef); if (!s.exists) { const result = crypto.randomInt(0,10); tx.create(roundRef,{ result, color:resultColor(result), duration:bet.duration, endsAt:bet.roundEndsAt, createdAt:FieldValue.serverTimestamp() }); } });
      resultDoc = await roundRef.get();
    }
    const n = Number(resultDoc.get('result')); const profit = resultPayout(bet.pick, Number(bet.amount), n);
    await db.runTransaction(async tx => { const [b,u] = await Promise.all([tx.get(betDoc.ref),tx.get(userRef)]); if (!b.exists || b.get('status') !== 'pending') return; const newCoins = Number(u.get('coins')||0) + (profit > 0 ? Number(b.get('amount')) + profit : 0); tx.update(userRef,{coins:newCoins,updatedAt:FieldValue.serverTimestamp()}); tx.update(betDoc.ref,{status:profit>0?'win':'loss',profit,result:n,settledAt:FieldValue.serverTimestamp()}); if (profit > 0) tx.set(userRef.collection('ledger').doc(),{type:'settlement',label:`Round result: ${n}`,delta:profit,betId:betDoc.id,createdAt:FieldValue.serverTimestamp()}); });
  }
}
function stampLabel(ts) { try { return ts?.toDate ? ts.toDate().toLocaleString('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}) : ''; } catch { return ''; } }
exports.getDashboard = onCall(async req => {
  const uid = requireUser(req); const duration = Number(req.data?.duration || 30); if (!durations.has(duration)) throw new HttpsError('invalid-argument','Invalid duration.');
  const userRef = await ensureUser(uid, '', req.auth.token.email); await settleDueBets(uid);
  const [u,betsSnap,ledgerSnap,roundsSnap,admin] = await Promise.all([userRef.get(),userRef.collection('bets').orderBy('createdAt','desc').limit(60).get(),userRef.collection('ledger').orderBy('createdAt','desc').limit(30).get(),db.collection('rounds').orderBy('createdAt','desc').limit(8).get(),isAdmin(uid)]);
  const bets=betsSnap.docs.map(d=>{const x=d.data();return {id:d.id,roundId:x.roundId,duration:x.duration,pick:x.pick,amount:x.amount,status:x.status,profit:x.profit,result:x.result,createdAtLabel:stampLabel(x.createdAt)}});
  const ledger=ledgerSnap.docs.map(d=>{const x=d.data();return {id:d.id,type:x.type,label:x.label,delta:x.delta,createdAtLabel:stampLabel(x.createdAt)}});
  const wins=bets.filter(x=>x.status==='win').length; const net=bets.reduce((sum,x)=>sum+(x.status==='pending'?0:Number(x.profit||0)),0);
  const ri=roundInfo(duration);
  return { profile:{coins:Number(u.get('coins')||0),displayName:u.get('displayName')||'Demo Player',bonusClaimed:!!u.get('bonusClaimed')},isAdmin:admin,stats:{totalBets:bets.length,wins,net},history:bets,recentResults:roundsSnap.docs.map(d=>({roundId:d.id,duration:d.get('duration'),result:d.get('result'),color:d.get('color')})),ledger,round:{id:ri.id,duration:ri.duration,endsAt:ri.endsAt} };
});
exports.adminAdjustBalance = onCall(async req => {
  const uid = requireUser(req); if (!(await isAdmin(uid))) throw new HttpsError('permission-denied','Admin access required.');
  const target=String(req.data?.uid||'').trim(), delta=Number(req.data?.delta), reason=String(req.data?.reason||'').trim().slice(0,200);
  if(!target||!Number.isSafeInteger(delta)||delta===0||Math.abs(delta)>100000||!reason) throw new HttpsError('invalid-argument','Invalid UID, delta or reason.');
  const targetRef=db.doc(`users/${target}`); await db.runTransaction(async tx=>{const s=await tx.get(targetRef);if(!s.exists)throw new HttpsError('not-found','Target user profile not found.');const next=Number(s.get('coins')||0)+delta;if(next<0)throw new HttpsError('failed-precondition','Balance cannot go below zero.');tx.update(targetRef,{coins:next,updatedAt:FieldValue.serverTimestamp()});tx.set(db.collection('adminAudit').doc(),{adminUid:uid,targetUid:target,delta,reason,createdAt:FieldValue.serverTimestamp()});tx.set(targetRef.collection('ledger').doc(),{type:'admin-adjustment',label:`Admin adjustment: ${reason}`,delta,createdAt:FieldValue.serverTimestamp()});});return {ok:true};
});
