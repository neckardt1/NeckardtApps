# Kamax sample workspace

Build the offline prototype from the repository root with Node 24:

```sh
npm ci
node prototypes/kamax/build.mjs
CHROME_BIN=/usr/bin/chromium node --test prototypes/kamax/*.test.mjs
```

Open `prototypes/kamax/dist/index.html` in a browser. Adjust `CHROME_BIN` for the local Chromium executable when running browser tests. The same self-contained file can be served over HTTPS. This prototype is separate from the Pages build and from PR #46. All fixtures, edits and simulation preferences live in this browser. The profile picker demonstrates household visibility on one device. It does not authenticate people.

Today mixes projects. Check a task to complete it, tap its name for details, swipe right to focus it, or swipe left for scheduling. The task menu provides the same choices with a mouse or keyboard. If all three slots are occupied, choose which task returns to the drawer. On a new day, available high-priority tasks planned specifically for that day may be suggested. Only explicitly chosen tasks enter the end-of-day check-in. Unselected work carries forward without a date edit.

Use **Preview lab** to simulate time, Muse nudges, a personal check-in and calendar blocks. In a project, the owner can change sharing for all of its tasks. Shared task edits are common to the two sample profiles. Each profile has its own focus list and integration preferences.
