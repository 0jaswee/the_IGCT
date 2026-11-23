# IGCT Game Changers Club

Mobile-first club site for **THE INVENCIABLE GAME CHANGERS TEAM (IGCT)**. It uses GitHub Pages for the website and Firebase Authentication + Cloud Firestore for shared profiles, group chat, doodles, game scores, and member controls.

## Included features

- Separate welcome, join, login, and club pages.
- Username + four-digit PIN sign-in. The PIN is expanded with PBKDF2 in the browser before it is used as the Firebase Authentication password; no email address is requested from a child.
- First account initializes the group and becomes admin. Create that account before sharing the public join QR.
- Admin can promote another member, pause/resume a member's group chat, pause/resume that member's doodle uploads, or remove them from the club.
- Admin can make a fresh QR invitation. Join links need the code included in the QR.
- Group chat with admin message removal.
- Quick Brain Boost trivia, daily Kindness Quest, Doodle Duel, and a team-star board.
- Responsive mobile navigation and original anime-inspired animal avatars.
- Firestore and Storage rules included in this repository.

## Firebase project already registered

The Firebase web app configuration is in `firebase-config.js`. Firebase API keys for web apps are not server secrets; access is controlled by Authentication and Security Rules. Do not add service-account keys to this repository.

The project is on the Spark no-cost plan, with a Firestore database in Mumbai and Email/Password Authentication enabled. The web app is registered. To deploy the database rules, open the Firebase project's Firestore **Rules** tab, paste `firestore.rules`, and click **Publish**. Keep Firestore rules in this repository in sync with the console rules.

## Publish on GitHub Pages

1. Upload all files in this folder to the root of a GitHub repository.
2. In the repository, choose **Settings → Pages**.
3. Select **Deploy from a branch**, choose `main` and `/ (root)`, then save.
4. Open the published website once the deployment finishes.
5. The intended group founder should join first, then open **Team → Team leader tools → Make a new team QR**. Do not share the QR until the first admin account is created.

GitHub Pages URLs use HTTPS, which the Firebase web SDK requires for secure authentication and PIN derivation.

## Photo uploads and free-plan limit

Photo uploads are deliberately off. Firebase now requires the pay-as-you-go Blaze plan to create/use Cloud Storage for Firebase. I did not link a billing account or enable a paid plan. `storage.rules` is supplied for a grown-up to review if they later choose to enable Storage and billing. Until then, kids can share small doodles saved in Firestore; member upload controls govern those doodles.

## Important child-safety notes

- Use nicknames only. Do not ask kids to enter full names, school, home address, phone number, birth date, or social accounts.
- The four-digit PIN is convenient for kids but is not strong account security. The group is intended to be adult-supervised, and the founder should keep the invite QR within the group.
- This starter does not include private one-to-one chat, voice/video, or location sharing.
- Admin tools are designed for a small, supervised club. Review all content and member controls before inviting children.

## Files

- `index.html`, `join.html`, `login.html`, `club.html` — separate pages.
- `styles.css`, `club-games.css` — responsive styling and game/club components.
- `app.js`, `firebase-config.js` — Firebase setup and app behavior.
- `firestore.rules`, `storage.rules` — server-side data access rules.

## Weekly art

Members can share five canvas doodles and vote for up to ten different teammate drawings in each Sunday-to-Saturday round. Deleting a drawing frees a slot. Votes can be edited until Sunday at 12:00 a.m. India time.

## Profile pictures

Members can upload or remove a small profile picture under Me. Publish the included Firestore rules to enable these updates. Gallery images are not accepted as art posts. The Art & Vote tab opens voting on Sundays, India time.

## Doodle Studio and stars

Open doodle.html through Try today's doodle. Use Brush, Fill, Eraser, Circle, Box, Undo, or Clear. Share up to five drawings per round. Publish the included firestore.rules to enable daily star tracking. Stars carry forward on the leaderboard. Activities award stars once per day, India time. The activities are casual and answers run in the browser.

## Install IGCT

Tap Install IGCT on the home page after deploying to GitHub Pages. The app opens on its own home screen. Sign-in, sharing and team data require internet access.

Publish the included Firestore rules for server enforcement of one star award per activity per India calendar day.

## Weekly cleanup and winner award

A new round starts at Sunday 12:00 a.m. India time. The scheduled workflow awards 100, 50 and 25 stars to the top three drawings with votes. The drawings remain in the Sunday results gallery. Other drawings and old ballots are deleted. Ties use drawing ID order. If fewer than three drawings received votes, fewer prizes are awarded. Each drawing earns its award even if the same artist places more than once.

1. Commit the ZIP contents to the default branch, including the hidden .github folder.
2. Publish the included firestore.rules in the IGCT Firebase console alongside the website update.
3. Create a dedicated Google Cloud service account in the IGCT project. Grant Cloud Datastore User for Firestore. If your organization permits service account keys, add its JSON key to the repository's Actions secrets as IGCT_FIREBASE_CREDENTIALS. Never commit the key or add it to any website file.
4. Enable Actions and run Close IGCT art week once from the Actions tab. The schedule runs Sundays around 00:07 and 02:07 India time. Scheduled starts can be delayed. The job processes only completed rounds, so it can be rerun if needed.

The previous single-vote ballots for an already-running round are counted when the voter has no replacement ballot. Older art leaves the current Art Corner when the week changes. Results, database cleanup, and awards appear after the scheduled job succeeds. Previously deleted art cannot be recovered. Art Corner shows the latest 12 ranked rounds.

## Admin PIN recovery

In Team, an active admin can use Allow PIN reset for another active teammate. Share the 15-minute code privately. On the login screen, the teammate opens Forgot your PIN?, enters their username and code, then chooses a new PIN. A fresh approval replaces the previous code. The functions use Firebase Admin to update the same account, so profile and stars are preserved.

Deploy the recovery functions from the project root with the Firebase CLI:

  firebase deploy --project igct-game-changers-club --only functions:allowPinReset,functions:checkPinReset,functions:finishPinReset

Firebase requires Blaze billing to deploy Cloud Functions. Use a runtime service account with Firebase Authentication Admin and Cloud Datastore User permissions for this project. The functions run on Firebase and the web files can stay on GitHub Pages. Publish the included Firestore rules as part of the update. No service account key is needed in the website or in this ZIP for PIN recovery.

Build 5 appears at the bottom of the home and login pages. Upload the contents of the ZIP directly to the GitHub Pages publishing folder so index.html and sw.js are at its root. Build 5 confirms the new frontend loaded. PIN resets still require the Firebase functions.


## Join an existing team or create one

Build 8 lets new members enter a team invite code, or scan the QR, and join on Firebase Spark. Keep the Team creation password blank for this flow. Existing members continue to log in with their username and PIN.

The separate Team creation password is only for the first admin creating a new club. Once the club exists, the backend refuses creating a second club. To enable that feature, deploy the Firebase Cloud Functions on Blaze and set the private secret interactively:

  firebase functions:secrets:set IGCT_JOIN_PASSWORD --project igct-game-changers-club
  firebase deploy --project igct-game-changers-club --only functions

The creation password is stored in Firebase Secret Manager. Publish the included firestore.rules when updating the site. Invite signup does not need Cloud Functions. To verify the new web files, look for Build 8 on the home or login screen.
