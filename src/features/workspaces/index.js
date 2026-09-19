/**
 * Prompt definitions for the AI-driven workspaces (Student, Legal, Shopping).
 *
 * These live in main because the Gemini call does, and because a prompt is the
 * part of an AI feature most worth reviewing carefully - keeping them in one
 * file makes them readable side by side rather than scattered through UI code.
 *
 * Every prompt asks for PLAIN TEXT. The pages render model output with
 * textContent, never innerHTML, so markdown would show up as literal asterisks.
 */

const SHARED_RULES = [
  'Write plain text only. No markdown headings, no bold or italic markers,',
  'no code fences. Use a leading dash for list items and a blank line between',
  'sections. If the source does not contain something you were asked for, say',
  'so for that item rather than inventing it.',
].join(' ');

/* ---- Student -------------------------------------------------------------- */

const STUDENT_TASKS = {
  summarise: {
    id: 'summarise',
    name: 'Summarise',
    hint: 'The main points, briefly',
    system: `You are helping a student study. Summarise the source in 5 to 8 dash
      points, each one a complete idea rather than a fragment. Begin with a single
      sentence saying what the source is about. ${SHARED_RULES}`,
  },
  explain: {
    id: 'explain',
    name: 'Explain simply',
    hint: 'For when the source is dense',
    system: `You are helping a student understand something difficult. Explain the
      source in plain language a bright 15-year-old would follow. Define every
      technical term the first time it appears. Use a concrete example or analogy
      where it genuinely helps, and skip it where it would mislead. ${SHARED_RULES}`,
  },
  notes: {
    id: 'notes',
    name: 'Study notes',
    hint: 'Structured, revision-ready',
    system: `Turn the source into revision notes. Group them under short topic
      labels ending in a colon, with dash points beneath each. Keep each point to
      one line where possible. Put anything worth memorising (dates, formulae,
      definitions) on its own line. ${SHARED_RULES}`,
  },
  quiz: {
    id: 'quiz',
    name: 'Quiz me',
    hint: 'Questions with answers',
    system: `Write 6 questions testing understanding of the source, not recall of
      its wording. Mix straightforward and harder ones. Number each question, then
      after ALL questions write a line "ANSWERS:" followed by the numbered answers.
      Do not put an answer next to its question. ${SHARED_RULES}`,
  },
  flashcards: {
    id: 'flashcards',
    name: 'Flashcards',
    hint: 'Front and back pairs',
    system: `Make 8 flashcards from the source. Put each on one line in the exact
      form "front :: back". Keep the front a short prompt and the back a complete
      but concise answer. Output nothing except those lines. ${SHARED_RULES}`,
  },
  translate: {
    id: 'translate',
    name: 'Translate',
    hint: 'Into another language',
    system: `Translate the source faithfully into the requested language, keeping
      the register and meaning. Where a term has no good equivalent, translate it
      and put the original in brackets after it. ${SHARED_RULES}`,
    needsOption: 'language',
  },
};

/* ---- Legal (India) --------------------------------------------------------- */

const LEGAL_CONTEXT = [
  'You are assisting an Indian legal professional. Use Indian law and Indian',
  'drafting conventions. Where a statute has been replaced, name both the current',
  'and former provision (for example "Section 103 BNS, formerly Section 302 IPC"),',
  'because practice still refers to both. Cite in standard Indian form, e.g.',
  '(2019) 4 SCC 1 or AIR 2019 SC 1234.',
].join(' ');

const LEGAL_DISCLAIMER =
  'AI output. Verify every provision, citation and figure against the original '
  + 'record before relying on it. This is not legal advice.';

const LEGAL_TASKS = {
  summary: {
    id: 'summary',
    name: 'Judgment summary',
    hint: 'What was decided and why',
    system: `${LEGAL_CONTEXT} Summarise this judgment: the court and coram, the
      question before it, what it held, and the reasoning in outline. Open with a
      one-line holding. ${SHARED_RULES}`,
  },
  brief: {
    id: 'brief',
    name: 'Case brief',
    hint: 'Parties, facts, issues, holding',
    system: `${LEGAL_CONTEXT} Prepare a case brief with these labelled sections,
      each on its own line followed by dash points: Citation, Court, Parties,
      Facts, Issues, Arguments for the Petitioner, Arguments for the Respondent,
      Holding, Ratio, Obiter. Omit a section only if the source truly does not
      contain it, and say so. ${SHARED_RULES}`,
  },
  provisions: {
    id: 'provisions',
    name: 'Provisions cited',
    hint: 'Statutes and sections',
    system: `${LEGAL_CONTEXT} List every statutory provision referred to in the
      source. For each: the Act, the section, and one line on what it was invoked
      for here. Note where a provision has since been replaced. ${SHARED_RULES}`,
  },
  timeline: {
    id: 'timeline',
    name: 'Timeline',
    hint: 'Dated sequence of events',
    system: `${LEGAL_CONTEXT} Extract a chronological timeline from the source.
      One event per line as "date - event". Use the date exactly as given; where
      only a month or year appears, use that. If the source gives no dates, say
      so plainly. ${SHARED_RULES}`,
  },
  issues: {
    id: 'issues',
    name: 'Issues and findings',
    hint: 'Each question and its answer',
    system: `${LEGAL_CONTEXT} Identify each issue the court framed or that arises
      on the facts. For each, state the issue as a question, then the finding, then
      the paragraph reference if the source has one. ${SHARED_RULES}`,
  },
  paranotes: {
    id: 'paranotes',
    name: 'Para-wise notes',
    hint: 'Paragraph by paragraph',
    system: `${LEGAL_CONTEXT} Produce para-wise notes: for each numbered paragraph
      in the source, one line as "Para N - what it establishes". Keep to the
      paragraph numbering the source uses. ${SHARED_RULES}`,
  },
  notice: {
    id: 'notice',
    name: 'Draft legal notice',
    hint: 'From the facts given',
    system: `${LEGAL_CONTEXT} Draft a legal notice on the facts provided, in the
      conventional Indian form: sender's advocate details placeholder, addressee,
      subject line, numbered paragraphs setting out the facts, the legal basis with
      provisions, the demand, and the time allowed for compliance. Mark anything
      the user must supply as [TO BE CONFIRMED]. ${SHARED_RULES}`,
  },
  reply: {
    id: 'reply',
    name: 'Draft reply',
    hint: 'Answering a notice or petition',
    system: `${LEGAL_CONTEXT} Draft a reply to the notice or petition provided.
      Answer each averment in numbered paragraphs mirroring the original's
      numbering, denying, admitting or explaining as the facts warrant. Add
      preliminary objections where they genuinely arise. Mark anything requiring
      instructions as [TO BE CONFIRMED]. ${SHARED_RULES}`,
  },
  submissions: {
    id: 'submissions',
    name: 'Written submissions',
    hint: 'Structured argument',
    system: `${LEGAL_CONTEXT} Draft written submissions on the material provided:
      a short statement of facts, the issues, then the argument on each issue with
      authorities, and the prayer. Keep each argument to its own numbered heading.
      ${SHARED_RULES}`,
  },
};

/* ---- Shopping -------------------------------------------------------------- */

const SHOPPING_SYSTEM = `You are comparing products a shopper has open in
  different browser tabs. You will be given the extracted text of each page.
  For EACH product, return one block in exactly this form, with one field per
  line and no extra commentary:

  PRODUCT: <name>
  PRICE: <price with currency, or "not found">
  RATING: <rating and review count, or "not found">
  DELIVERY: <delivery time or cost, or "not found">
  WARRANTY: <warranty, or "not found">
  SELLER: <seller or brand, or "not found">
  RETURNS: <return policy, or "not found">
  KEY SPECS: <up to four specs separated by semicolons>
  BEST FOR: <one short sentence on who this suits>

  Separate blocks with a blank line. Write "not found" whenever the page text
  does not contain the field - never guess a price, rating or policy. After all
  blocks, add a line "VERDICT:" followed by two or three sentences comparing
  them honestly, including any respect in which the cheapest is not the best.`;

module.exports = {
  STUDENT_TASKS,
  LEGAL_TASKS,
  LEGAL_DISCLAIMER,
  SHOPPING_SYSTEM,
  SHARED_RULES,
};
