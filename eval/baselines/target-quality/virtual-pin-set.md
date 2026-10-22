# Target run — virtual card, PIN set

Hand-authored. Quality bar for discovery + strategy, not a model transcript.

**Brief:** We are issuing virtual cards immediately. We want more customers to set their PIN.

**Context the strategist already has (not asked):**

- Risk appetite: none on file → fuller plan (more touches and tests).
- Channels: SMS, WhatsApp, email, in-app.
- Do not message 9 at night to 9 in the morning.
- No earlier campaign like this. No proven barrier, no proven split.
- General IBL: WhatsApp and in-app are read more than email. SMS is mainly to reach people.
- DND list is not used at this stage.

The conversation below was drafted before we froze “never ask quiet hours.” In a live run, the quiet-hours / Sunday question must **not** appear; those hours come from context and are only applied in the plan.

---

**You:** We’re issuing virtual cards immediately. I want more customers to set their PIN. That’s the goal.

**Strategist:** Virtual is live at issue. We need PIN set.

What counts as PIN set?

How long after issue do you still care?

Who already does it — app, new vs existing, assigned limit — even as a hunch?

---

**You:** PIN set in the app. First two weeks. App-on-phone does it more. New-to-bank slower. RMs say higher limit is faster; never sliced. No report.

**Strategist:** Those may be the same people. I will not glue them.

New-to-bank slower because they don’t have the app, or they have it and still don’t set PIN?

Limit ever pulled from “already a customer,” or RM hunch only?

What else at issue would you treat differently?

---

**You:** New-to-bank often don’t have the app. Existing almost always do. Never separated limit. We know branch vs digital.

**Strategist:** Then new vs existing is the app split for now. Limit we look at after — I will not invent a band.

If they get a message and don’t set PIN, what can you see — not delivered, not opened, opened, clicked through?

What do they already get at issue?

Once PIN is set, we stop. Confirm.

---

**You:** Delivered, opened, clicked — yes. Not where they drop in the PIN screens. “Your card is ready” SMS at issue. PIN set, stop.

**Strategist:** So we can tell reach vs saw-and-ignored vs started-and-quit.

Which rails we can use after that SMS, and DND, should come from context in a live run — not this question.

When people **do** set PIN today, when does that happen relative to issue — same sitting, that evening, days later — or have you never looked?

---

**You:** SMS, WhatsApp, email. SMS DND is ugly; don’t retry SMS. WhatsApp we use sparingly, it gets read. Email is cheap and ignored. Quiet hours 9pm–9am, no sends. We’ve never looked at hour-of-day. People who set PIN at all mostly do it the same day or next; after a week it’s rare. Ten percent holdout. Install in scope. Don’t know vs don’t bother — can’t rank.

*(Live run: channels, quiet hours, and DND are context. The manager would only need to give the timing hunch, holdout, install, and the two unranked reasons.)*

---

**Strategist:** Here is the plan.

**What I am taking from you**  
Virtual only. Count: PIN set in the app. Window: 14 days from issue. People with the app set PIN more. New-to-bank are slower and often do not have the app. Existing customers almost always have the app. Higher limit is an RM hunch, never sliced, no rule for “high.” You know branch vs digital. They already get “your card is ready” on SMS at issue. You can see whether a message reached them, whether they opened it, and whether they clicked. You cannot see where they dropped inside the PIN screens. Two reasons you cannot rank: they don’t know PIN is in the app, or they cannot be bothered. Putting the app on the phone is in scope. Stop when PIN is set. Do not retry SMS. WhatsApp is read; use it carefully. Email is weak. People who set PIN at all mostly do it the same day or the next; after a week it is rare. Ten percent stay on the issue SMS only. Hard stop at two weeks.

**What I am adding**  
There is no old PIN campaign to copy. Anything about “what works” is yours or assumed.  
I will not repeat “your card is ready.”  
The first real split is whether they can open the app. That is where new-to-bank will sit. I will not also split new vs existing — that would be the same people twice.  
I will not target “high limit.” If we can see assigned limit in reporting, we look at PIN-set by limit afterwards.  
The test belongs only on people who can set PIN today (they have the app) **and** who saw us and did not start: how to set PIN vs why bother. On people with no app, the job is install. On people who clicked into the app, the job is finish, not a slogan.  
A person who never got the message has a reach problem. Copy tests on them teach nothing.  
Day 0 they have not looked. Day 10 they forgot. The same “set your PIN” on both is lazy.  
WhatsApp is for people who did not see us, not for people who already opened WhatsApp. In-app is a normal channel, like WhatsApp.  
I will not message between 9 at night and 9 in the morning. If a send would fall there, it waits until 9 in the morning.

I would not: one three-message blast; one test on the whole base; a homemade limit cutoff.

---

**How it runs**

Ten percent get only the issue SMS.

**No app**  
Job: install, then PIN.  
First install prompt as soon as we are allowed after issue — same day if we can. That is when your converters move.  
They already got SMS, so the first campaign message is WhatsApp (install + PIN).  
If WhatsApp does not land → in-app if they might still see the app, else one email. Do not go back to SMS.  
If they do not open WhatsApp by the next allowed evening (still day 0–1) → one email. Still nothing → stop until a last message for people who never engaged.  
If they open but do not install → how to install, stay on WhatsApp.  
If they install → they join the “have app” path at that moment, not at the next scheduled blast.  
PIN set → they leave, any time.

**Have app**  
Voice: branch vs digital (“it is live now, you do not wait for plastic”).  
First PIN prompt: first allowed slot after issue, same day. Not two days later.  
First PIN prompt channel: WhatsApp and in-app. SMS already said ready. Email is too weak for the only prompt that catches same-day converters.  
That first send is not the test. It is a short “PIN is in the app, do it now.” We learn from what they do to that.

**After the first PIN prompt**

PIN set → out. Always. No later message.

Did not reach them → try the other channel in the next allowed slot, same ask. If WhatsApp and in-app/email both fail → stop. No copy test.

Reached them, never opened → they did not see it. Copy does not matter. Try a different time of day still in day 0–1 (if first was morning, next is evening before 9 at night, or the reverse). Change the channel they ignored. Still unopened after two times of day and two channels → wait for one last message around day 7–10, then stop. No weekly drip.

Opened, did not click → they saw us and did not start. **This is the only place we run a test:**  
- one group: where to set PIN  
- the other group: what they can do once PIN exists  

Send that in the same or next allowed slot. Stay on the channel they opened.  
If they do not open the test → treat as reach once (other channel, other time of day), then stop looping.  
If they open again and still do not click → they are refusing. One last true consequence, on the channel they read, then stop. Do not send how-to again.  
If they click → the test is over. They are “started, did not finish.” Both test groups are treated the same from here.

Clicked, PIN not set → they meant to do it. No slogans. Next allowed hours, same day if we can, on the channel they clicked. If they click again and still no PIN → one more finish reminder, then stop. We cannot see OTP vs confirm PIN, so we do not guess. If they never come back after the first click → one recovery on the other channel, next allowed evening (not the same minute), then stop.

**Late window**  
Days 2–6: no new story for people already in recovery or who already said no.  
Still unopened around day 7–10: one last message, WhatsApp if we have not used it on them, else in-app or email, evening before 9 at night. Then stop.  
People who already refused or clicked twice with no PIN: no day-10 last chance.  
Day 14: hard stop.

**How we will know**  
PIN set vs the 10% who only got the issue SMS.  
Then where it happened: first prompt / unopened timing switch / opened-no-click test (and which group) / click recovery.  
Then which channel and which time.  
Then PIN set by assigned limit, so the RM hunch becomes a number. We still do not use a limit cutoff to decide who enters.

---

**You:** Yes. We can split app-installed. We see open and click. Limit is reporting only.

**Strategist:** Then we will build that. App is the first split. Open vs click vs PIN-set are the branches. The test sits only on people who opened and did not start. Clicked and dropped is recovery, not a slogan. After you approve, we map “reached / opened / clicked” onto what the platform can actually see. If a branch cannot be built, I will tell you then.

---

**You:** If they clicked twice and still no PIN, don’t keep selling. And don’t WhatsApp someone who already opened WhatsApp just to try again.

**Strategist:** Both already in the plan: two finish reminders then stop; if they opened on WhatsApp, we stay on WhatsApp for that conversation. WhatsApp is not a reminder hammer. Changing to another channel is only for people who never opened. The 10% group, two-week clock, and stopping when PIN is set do not change.

---

## What a bad current run does instead (do not regress to this)

One question about virtual vs physical as a platform limit, then EMAIL → SMS → WhatsApp every 48 hours, cheaper-first, 3 of 4 messages, generic copy for all card types, no test, no open-vs-click branches.
