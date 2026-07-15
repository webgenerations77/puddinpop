# Prompt: sync ServSafe Food Manager facts into this app

**Before you paste this prompt, set the model to Sonnet 5 to conserve usage
credits:** run `/model sonnet`. This is a read-and-reconcile task — Sonnet 5
handles it accurately and costs far less than Opus/Fable. Do not use a
premium model for this.

Open a new session inside the target app's folder (run this once for Puddin
Pop, once for Kenzie), set the model as above, then paste everything in the
box below.

---

```
Use Claude Sonnet 5 for this task (if you are not Sonnet, tell me before continuing).

You are updating the food-safety study content in THIS app (the one in the
current working directory) to match the authoritative, exam-accurate content
in the ServSafe Food Manager source document. This is a one-way sync: the
source document is the source of truth; only food-safety FACTS flow in. Do
NOT import its formatting, headings style, or voice — keep THIS app's own
format, tone, and structure.

SOURCE OF TRUTH (read-only, read it fully first):
C:\Users\webge\OneDrive\Desktop\Apps\Prepline\docs\sync\servsafe-food-manager-source.md

It has 8 domains: Food Safety & Contamination; Time & Temperature; Personal
Hygiene; Cleaning & Sanitizing; Pest Control & Facilities; Receiving &
Storage; HACCP & Active Managerial Control; Facilities & Equipment. Each
lesson lists a body, example, key points (✅ do / ❌ never / 💡 tip), why it
matters, a memory hook, and an exam tip.

TASK — blend, do not clobber:
1. Inventory this app's existing food-safety content and note its format
   (HTML sections, JSON, markdown, quiz questions, whatever it is).
2. For each authoritative fact/topic in the source:
   - Already covered here and AGREES  -> leave it.
   - Covered here but DISAGREES or is outdated -> flag as a CONFLICT (show
     this app's version vs. the source version), propose the corrected
     text. Never silently overwrite.
   - MISSING here -> add it, written in THIS app's existing voice and format
     (do not paste the source verbatim).
3. Preserve this app's structure, styling, and any personas/branding it
   already has. You are changing food-safety facts, not the app's identity.

HIGH-PRIORITY ACCURACY ANCHORS — if any existing content here contradicts
these, it is a CONFLICT to fix (these are the corrections that motivated the
sync):
  - Danger zone 41°F-135°F; 4 CUMULATIVE hours max before discard.
  - Cook temps: poultry / stuffed / reheated 165°F; ground meats 155°F;
    whole cuts & seafood 145°F; roasts 145°F + 3-min rest; produce for hot
    holding 135°F. Reheat to 165°F within 2 hours.
  - Cooling: 135°F->70°F within 2 hours, then 70°F->41°F within 4 more
    (6 hours total); discard if stage 1 misses the 2-hour mark.
  - High-temp dishwasher: final-rinse WATER at the manifold >=180°F, but the
    dish SURFACE only needs >=160°F. Chemical machine water >=120°F.
  - Norovirus exclusion: return only after 24 hours symptom-free (NOT 48).
  - The 9 major allergens: milk, eggs, fish, shellfish, tree nuts, peanuts,
    wheat, soybeans, sesame (sesame added to US law January 2023). Allergens
    are not destroyed by cooking.
  - Refrigerator storage order top->bottom by minimum cook temp: ready-to-eat,
    seafood 145°F, whole beef/pork 145°F, ground meat 155°F, poultry 165°F.
  - FAT TOM (Food, Acidity, Time, Temperature, Oxygen, Moisture).
  - Big 5 reportable pathogens: Norovirus, Salmonella Typhi, Shigella, STEC,
    Hepatitis A. HACCP's 7 principles. Date marking 7 days at 41°F, counting
    the prep/open day as day 1.

TRADEMARK NOTE: "ServSafe" is a National Restaurant Association trademark.
Use it only nominatively ("prep for the ServSafe exam"), never as if this app
IS ServSafe or is endorsed by it. Flag any content here that crosses that line.

OUTPUT — do NOT edit any files yet. First write a report to
SYNC-FROM-SERVSAFE.md in this app's folder, with three sections:
  - MATCHES: already-correct items (brief list).
  - CONFLICTS: this app's version vs. source version vs. your proposed fix.
  - ADDITIONS: new topics/lessons to add, drafted in this app's format.
Then STOP and wait for my go-ahead before applying anything.
```
