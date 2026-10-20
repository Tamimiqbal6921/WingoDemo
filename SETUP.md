# WingoDemo setup (Android-friendly steps)

This project is **virtual-coins-only**. It does not take deposits or process withdrawals.

## 1. Firebase console
1. Open https://console.firebase.google.com/ and choose project `wingodemo`.
2. Authentication → Sign-in method → enable **Email/Password**.
3. Authentication → Settings → Authorized domains: make sure your GitHub Pages domain is listed if you host there.
4. Build → Firestore Database → Create database.
5. In Project settings → Your apps, check the web app config in `index.html` matches your Firebase web app.

## 2. Deploy the backend (required for balances/bets)
Cloud Functions need the Firebase CLI and a project with billing/Blaze enabled in many regions. From a computer or a cloud IDE with a terminal:

```bash
npm install -g firebase-tools
firebase login
cd wingodemo
firebase use wingodemo
cd functions && npm install && cd ..
firebase deploy --only firestore:rules,functions
```

If the project asks to upgrade billing for Cloud Functions, do not continue unless you understand the possible charges. You can use a Firebase-compatible cloud IDE/terminal; GitHub Pages alone cannot run Cloud Functions.

## 3. Create the first admin securely
1. Sign up through the app using your own account.
2. Firebase Console → Firestore Database → Data → Start collection `admins`.
3. Document ID must be **your Firebase Authentication user UID** (copy it from Authentication → Users).
4. Add field `enabled` with type **boolean** and value `true`.

Never put an admin email, password, UID allowlist or `isAdmin=true` privilege in frontend HTML. Admin access is granted by the Firestore `admins/{uid}` document created manually in the console. The browser cannot write Firestore documents directly because the rules deny all direct client reads/writes; trusted Cloud Functions handle game state.

## 4. Publish the website
Put `index.html` on GitHub Pages (root of the selected branch). Deploy Cloud Functions and Firestore rules separately using Firebase CLI. GitHub Pages only serves the frontend; it does not deploy Firebase Functions.

## Notes
- Firebase web API keys identify the project and are not passwords; keep user passwords private.
- Demo rounds use server-side generated results after a round closes. A round result is shared by users who settle that round.
- The starter reward is 50 virtual coins, claimable once per account.
- This is a learning/demo project, not a certified wagering system. Do not add real-money deposits, withdrawals or claims of guaranteed winnings.
