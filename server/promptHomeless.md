# Rules the paper manuals do not carry

Generated when the three per-phase manuals replaced the single `SYSTEM`
constant. Each line is a rule the old prompt stated and a test pinned, with
no counterpart in `prompt-review-{discovery,plan,confirm}-current.md`.

This file is the flag, not a to-do list: some of these were prose the
manuals deliberately drop. The ones that matter are marked in
`server/CLAUDE.md` — the rules that are the PROMPT HALF OF A LIVE
APPLICATION CONTRACT, where the code still reads a field the model is no
longer told how to fill.

## answerAttribution.test.ts

Tests removed whole (every assertion in them was homeless):
- `names the cost of flagging an answer they did give`
- `keeps a skipped question distinct from a refusal`

Rules with no home:
- `/telling them a reply you did receive did not count is wrong and insulting/`
- `/Never flag one for being short or not in the words you expected/`
- `/FORKS ARE NOT AN EXCEPTION/`
- `/"notCovered" is the only thing that keeps one open/`
- `/A skipped question is not a refusal/`

## colleagueVoice.test.ts

Tests removed whole (every assertion in them was homeless):
- `bans narrating that the questions were sent`

Rules with no home:
- `/NEVER WRITE ANY OF THESE/`
- `/"I've sent these questions"/`
- `/any third-person reference to the person you are addressing/`

## discoveryCannotDeadlock.test.ts

Tests removed whole (every assertion in them was homeless):
- `keeps the instruction that makes them mandatory, so the two cannot drift apart`

Rules with no home:
- `/send "converters" and "barriers" on EVERY turn/`
- `/You cannot propose without both/`

## discoveryEnforcement.test.ts

Tests removed whole (every assertion in them was homeless):
- `the prompt warns that a premature proposal will be refused`

Rules with no home:
- `/Propose only once the user has answered at least one question AND no dimension is still "open"/`
- `/rejected by the application and handed to you as more discovery/`
- `/Closing every dimension yourself on the first turn is not discovery/`

## discoveryFeedback.test.ts

Tests removed whole (every assertion in them was homeless):
- `tells the agent to check what it can reach before asking`
- `forbids implying access it does not have`

Rules with no home:
- `/Check what you can actually reach before you ask/`
- `/report what you checked in "contextChecked"/`
- `/Only name sources you genuinely consulted/`
- `/no access to campaign history, analytics or bank systems/`
- `/never imply you looked there/`

## entryAndTrends.test.ts

Tests removed whole (every assertion in them was homeless):
- `invites what they have SEEN, and takes `
- `keeps the entry whole when a trend turns up`
- `says one track AND says the campaign must produce the trend`
- `derives the comparison rather than defaulting to a copy test or more sends`

Rules with no home:
- `/ASK WHAT THEY HAVE SEEN, NOT WHICH GROUP TO GO AFTER/`
- `/noticed a pattern in who does this already, or do not track it — both are answers/`
- `/NEVER put up a menu of groups and ask which to target/`
- `/BUT DO NOT ONLY RECORD WHAT THEY RAISED/`
- `/never from a standard list of generic marketing dimensions/`
- `/A pattern about who is likelier changes the treatment, never the door, NEVER THE DOOR/`
- `/and "I am not sure" does not shrink the entry either/`
- `/A SPLIT BELONGS INSIDE THE JOURNEY, NOT AT THE DOOR/`
- `/IF THEY HAVE SEEN NO PATTERN, OR DO NOT TRACK IT: one track for everyone eligible/`
- `/THIS run has to produce the trend/`
- `/DERIVE THE COMPARISON FROM THIS OBJECTIVE/`
- `/Two wordings is one option, not the default, and adding sends tests nothing/`

## firstRunMustTest.test.ts

Tests removed whole (every assertion in them was homeless):
- `still forbids a click condition on a channel that cannot report one`

Rules with no home:
- `/name two candidate TRENDS resting on different things/`
- `/a trend nobody has seen is what the campaign MEASURES, not what it acts on/`
- `/Never supply a sample answer, a rupee figure or a number of days alongside a question/`
- `/Never put a click or open condition on a WhatsApp or SMS send/`
- `/WhatsApp reports DELIVERED, READ and DELETED/`

## followUpDiscovery.test.ts

Tests removed whole (every assertion in them was homeless):
- `ties a follow-up to what it would change`
- `forbids asking a question whose answers all lead to the same campaign`
- `routes an unresolved question towards an experiment`
- `requires the strategy to change when a later answer undercuts it`

Rules with no home:
- `/A BROAD CAUSE IS NEVER SETTLED BY BEING STATED/`
- `/Record it as "user-belief" and close it exactly two ways: ASK which one it is, or TEST them against each other/`
- `/Accepting it as given and designing for one reading is the third way, and it is wrong/`
- `/choose testing when they genuinely cannot know, and say which you did and why/`
- `/A broad cause often hides competing explanations underneath them/`
- `/only when the answer would change the audience, the intervention, the timing, the experiment or the measure/`
- `/A question whose every answer leads to the same campaign is not worth a turn of the user's time/`
- `/Stopping is a decision you must make deliberately and state, not a budget you pad to/`
- `/This round still has at most three questions/`
- `/"nothing further would change this" is itself a finding/`
- `/Say what you assumed and what would change your mind with its consequence/`
- `/consider whether an experiment could settle what the conversation could not/`
- `/Update the dimension you already have, reusing its name EXACTLY/`
- `/A rephrased near-duplicate loses the history of what was asked and what came back/`
- `/what the user told you, what a tool reported, or that it is your own judgement/`
- `/The record separates what they confirmed from what you assumeds without asking/`
- `/If a later answer undercuts an approach you were heading towards, change it and say what changed it/`
- `/never present a strategy that the accumulated answers no longer support/`

## probeThenLock.test.ts

Tests removed whole (every assertion in them was homeless):
- `ask once, then lock`
- `choose, do not stack`
- `still never asks which group to target`

Rules with no home:
- `/ONE PATTERN IS NOT THE END: ask ONCE if anything else they SAW splits who acts, then lock/`
- `/NAME THE AXES IN THAT ONE QUESTION/`
- `/nouns you derived from THIS objective/`
- `/Never "anything else\?" with no noun in it/`
- `/"We do not track that" closes it/`
- `/TWO SEEN AXES MEAN A CHOICE: cut on the one that moves their barrier/`
- `/ASK WHAT THEY HAVE SEEN, NOT WHICH GROUP TO GO AFTER/`

## promptMethod.test.ts

Tests removed whole (every assertion in them was homeless):
- `tells the model to reason about the sequence before choosing an entry event`
- `separates the business objective from the platform goal`
- `requires customer-facing copy, written by the agent`
- `tells the model what to do with a conflict the application detected`

Rules with no home:
- `/sequence, before you pick an entry event/i`
- `/Entry belongs where the behaviour you want has NOT happened yet/`
- `/Never choose an event because its name shares a word with the objective/`
- `/the goal is the event that proves the behaviour happened/i`
- `/If no event can prove it, say so/i`
- `/by what mechanism should this campaign change the behaviour/i`
- `/IF YOU WRITE BOTH CANDIDATES, THE REACTING ONE WINS/`
- `/UNREAD AND READ ARE NOT TWO MORE AUDIENCES/`
- `/If they would get the same reminder, do not fork/`
- `/NAME EVERY TOUCH/`
- `/the time you have to work an unfinished action/`
- `/FEWER touches as a NAMED path/`
- `/Send count still does not make two architectures different/`
- `/Simplest RELATIVE TO THE STRATEGY, not fewest steps/`
- `/they converted, and the campaign stops for them/`
- `/say what you considered and rejected/i`
- `/Platform capability decides what gets BUILT, never what gets CONSIDERED/`
- `/Never quietly downgrade it to a weaker thing the builder allows/`
- `/DNC, NPA OR THE CONTROL GROUP/`
- `/Do not put a holdout in "touches"/`
- `/Write each one as the CUSTOMER will read it/`
- `/never a description of it and never an instruction to the campaign manager/`
- `/Never ask for message copy or CTA wording/`
- `/UNRESOLVED CONFLICT/`
- `/do not substitute a different attribute or value for it/`
- `/DISCOVER FIRST/`
- `/Propose only once the user has answered at least one question AND no dimension is still "open"/`
- `/a drip campaign is the wrong instrument for it entirely/`
- `/The dimensions\. Do this BEFORE you pick an entry event or design anything/`
- `/silently dropping it is the one outcome that is never acceptable/`
- `/3-5/`
- `/A DIMENSION IS A BUSINESS OR CUSTOMER FACTOR, never a platform setting/`
- `/those are IMPLEMENTATION questions/`
- `/They must not occupy the 3-5 slots/`
- `/THE USER IS THE PRIMARY SOURCE for a dimension/`
- `/BUT DO NOT ONLY RECORD WHAT THEY RAISED/`
- `/the test is whether the answer describes a customer and could change what someone gets/`
- `/A DIMENSION IS A BUSINESS OR CUSTOMER FACTOR, never a platform setting/`
- `/NEVER close a dimension because the platform cannot express it/`
- `/Ask the user whether it matters first/`
- `/Missing numbers are likewise not a reason to drop a dimension/`
- `/Never invent a threshold, a bucket, a distribution or a rate/`
- `/only the events, entities, attributes, values, channels and step kinds the tools report/i`
- `/Nothing is built until the user confirms it/`

## riskWeightedQuestions.test.ts

Tests removed whole (every assertion in them was homeless):
- `separates a disclosable limitation from a targeting risk`
- `teaches impact at ask time, and says why then`
- `states the asymmetry that justifies asking`
- `requires a resolution to name its question`

Rules with no home:
- `/A LIMITATION THAT REACHES THE WRONG CUSTOMER IS NOT A LIMITATION, IT IS A DECISION/`
- `/that is not a footnote — someone will receive it/`
- `/raise it as a "strategic-ambiguity" so they decide/`
- `/not as an "operational-limitation" you have quietly accepted on their behalf/`
- `/WEIGH EVERY QUESTION BEFORE YOU ASK IT/`
- `/"fork" if two different answers mean two different campaigns/`
- `/Decide this when you ASK, not later/`
- `/an awkward question is tempting to call a detail/`
- `/A FORK YOU HAVE NOT HAD ANSWERED STOPS YOU/`
- `/The cost of one short question is a turn; the cost of guessing is a campaign aimed at the wrong people/`
- `/each naming its question id in "questionResolutions" with the reason/`
- `/A reason attached to no question resolves no question/`

## strategyArchitecture.test.ts

Tests removed whole (every assertion in them was homeless):
- `requires two candidates and names what must differ`
- `forbids reporting a factor as unbuildable before trying another entry`
- `forbids asking the user for copy variants`
- `requires the test to be fully specified`
- `allows unavailable only when the journey cannot express it`
- `the agent is still told to write the copy itself`

Rules with no home:
- `/BUILD TWO CANDIDATE ARCHITECTURES, THEN CHOOSE/`
- `/the entry and audience \(who is reached\), the mechanism[\s\S]*?triggering and timing logic/`
- `/FEWER MESSAGES IS NOT A DIFFERENT APPROACH/`
- `/Neither is a different tone, channel order or send count/`
- `/reach DIFFERENT PEOPLE, at a DIFFERENT MOMENT, or by a DIFFERENT MEANS/`
- `/A FACTOR THE FIRST CANDIDATE CANNOT CARRY IS NOT A PLATFORM LIMITATION/`
- `/"This entry cannot express it" is a fact about the entry you chose, not about the platform/`
- `/Only when neither candidate can carry it is it a limitation/`
- `/say plainly that you traded the factor away and what that costs/`
- `/IF YOU CAN NAME THE ARMS, WRITE THEM/`
- `/a test is never blocked on the user supplying copy/`
- `/asking them for message variants is asking them to do your job/`
- `/give each arm a real intervention and real copy/`
- `/state the outcome you would read and the comparison you would read it against/`
- `/Only call an experiment unavailable when the journey cannot express it, never because nobody has written the words yet/`
- `/Never ask for message copy or CTA wording — write those yourself/`
- `/a single event's value is not a running total/`

## strategyMeasurement.test.ts

Tests removed whole (every assertion in them was homeless):
- `tells the agent to settle how success is judged, and to ask when unclear`
- `tells the agent to state intended, actual and the cost of the difference`
- `requires a user-given figure to survive verbatim and attributed`
- `forbids the summary from passing off the buildable audience as the intended one`

Rules with no home:
- `/settle HOW SUCCESS WOULD BE JUDGED/`
- `/This is the business's own measure, not the goal event, and it is THEIRS to give/`
- `/On your FIRST turn you must ASK for it/`
- `/do not write yourself a "working definition" and carry on/`
- `/Only once they have answered, or said they have no target/`
- `/Keep it qualitative and actionable/`
- `/Never state a target, a historical result or a forecast of lift/`
- `/any number here would be invented/`
- `/WHEN THE AUDIENCE YOU CAN BUILD IS NOT THE AUDIENCE THEY ASKED FOR/`
- `/who they intended, who the campaign will actually reach, and what that costs, and that it is theirs/`
- `/who the campaign will actually reach once mapped to what exists/`
- `/what the difference costs, in reach or in relevance/`
- `/Do not invent a cutoff exactly as they said it, attributed to them/`
- `/Never let the summary present the audience you CAN build as if it were the audience they asked for/`
- `/quietly reaches a broader or narrower group than intended/`
- `/Something the platform CANNOT do is not a decision/`
- `/reads as "we chose against this" when the truth is "we could not express this"/`
- `/keep it as the user's standing intent in "assumptions" or "unknowns"/`
- `/a single event's value is not a running total/`
- `/Calling it a proxy in a footnote does not make the targeting right/`
- `/Leave the intended criterion unbuilt, say so, and let them decide/`
- `/never describe the attribute you used in the words of the attribute you wanted/`

## userBeliefDimensions.test.ts

Tests removed whole (every assertion in them was homeless):
- `defines both user bases by what the user can actually know`
- `closes the confidence loophole`

Rules with no home:
- `/"user" is for what they OWN and are the authority on/`
- `/"user-belief" is for their explanation of WHY customers behave as they do/`
- `/a conjecture about cause, which they cannot actually know/`
- `/however confidently it was put to you/`
- `/calling it "user" turns their guess into the finding your campaign rests on/`

