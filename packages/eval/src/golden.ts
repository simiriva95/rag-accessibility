/**
 * The golden set. Written before any tuning, so the numbers it produces mean
 * something.
 *
 * Relevance is annotated as an anchor — a document, optionally narrowed to a
 * section — rather than as a raw chunk id. Chunk ids are content-addressed and
 * stable across a re-index, but not across a change to the chunker itself, and
 * re-annotating 40 questions by hand every time a parameter moves is how a
 * golden set quietly stops being maintained. resolve.ts turns anchors into the
 * chunk ids the harness actually scores, and fails loudly when an anchor stops
 * matching anything.
 *
 * Relevance is graded, because a single flat label saturates. Annotating every
 * chunk of the right document as relevant marks up to 2.8% of the corpus for
 * one question, and Recall@5 then reads 1.0 for a retriever that learned
 * nothing. So:
 *
 *   grade 2  primary — the chunk that actually answers the question
 *   grade 1  related — same document, useful context, not the answer
 *   grade 0  everything else
 *
 * Recall and MRR are measured against the primary chunks alone; nDCG uses both
 * grades, which is what graded relevance is for.
 *
 * The four kinds each exist for a reason:
 *  - identifier  the queries dense retrieval blurs together. The empirical
 *                argument for hybrid search lives or dies here.
 *  - conceptual  paraphrases with no shared vocabulary, where BM25 struggles.
 *  - design      cross-source questions: the answer is in GOV.UK, not WCAG.
 *  - refusal     questions this corpus genuinely cannot answer. A system that
 *                scores well everywhere else and still invents an answer here
 *                has failed at the thing the project is about.
 */

export type GoldAnchor = {
  docId: string;
  /** Substring of the chunk's deepest heading; omit for document-level relevance. */
  heading?: string;
};

export type GoldenQuestion = {
  id: string;
  question: string;
  kind: 'identifier' | 'conceptual' | 'design' | 'refusal';
  /** Chunks that answer the question. Grade 2. Empty exactly when kind is 'refusal'. */
  primary: GoldAnchor[];
  /**
   * Context worth retrieving but not an answer. Grade 1. Defaults to every
   * chunk of the documents the primary anchors point at.
   */
  related?: GoldAnchor[];
  /** Why this question is in the set, when it is not obvious. */
  note?: string;
};

export const GOLDEN: GoldenQuestion[] = [
  // ── identifier ────────────────────────────────────────────────────────────
  {
    id: 'sc-2-4-11',
    question: 'What does Success Criterion 2.4.11 require?',
    kind: 'identifier',
    primary: [
      { docId: 'wcag22', heading: 'Success Criterion 2.4.11' },
      { docId: 'understanding/focus-not-obscured-minimum', heading: 'In Brief' },
    ],
    related: [{ docId: 'understanding/focus-not-obscured-minimum' }],
    note: 'The number is the whole query. Embeddings place 2.4.11 next to every other criterion number.',
  },
  {
    id: 'sc-1-4-3-ratio',
    question: 'What contrast ratio does SC 1.4.3 require for normal size text?',
    kind: 'identifier',
    primary: [
      { docId: 'wcag22', heading: 'Success Criterion 1.4.3' },
      { docId: 'understanding/contrast-minimum', heading: 'In Brief' },
    ],
    related: [{ docId: 'understanding/contrast-minimum' }],
  },
  {
    id: 'sc-1-4-11',
    question: 'What is the minimum contrast for user interface components under 1.4.11?',
    kind: 'identifier',
    primary: [
      { docId: 'wcag22', heading: 'Success Criterion 1.4.11' },
      { docId: 'understanding/non-text-contrast', heading: 'In Brief' },
    ],
    related: [{ docId: 'understanding/non-text-contrast' }],
  },
  {
    id: 'aria-describedby',
    question: 'How is aria-describedby used to attach a hint to a form field?',
    kind: 'identifier',
    primary: [
      { docId: 'understanding/labels-or-instructions', heading: 'Techniques' },
      { docId: 'govuk/components/file-upload', heading: 'About HTML attributes' },
    ],
    note: 'A hyphenated attribute name: exactly the token a subword embedding smears out.',
  },
  {
    id: 'prefers-reduced-motion',
    question: 'How should prefers-reduced-motion be handled?',
    kind: 'identifier',
    primary: [{ docId: 'understanding/animation-from-interactions', heading: 'Sufficient Techniques' }],
    note: 'A CSS media feature, three kebab-case parts, none of them distinctive on its own.',
  },
  {
    id: 'sc-2-4-12-level',
    question: 'Which conformance level is Focus Not Obscured (Enhanced)?',
    kind: 'identifier',
    primary: [
      { docId: 'wcag22', heading: 'Success Criterion 2.4.12' },
      { docId: 'understanding/focus-not-obscured-enhanced', heading: 'In Brief' },
    ],
    related: [{ docId: 'understanding/focus-not-obscured-enhanced' }],
  },
  {
    id: 'sc-2-5-8',
    question: 'What is the minimum target size under 2.5.8?',
    kind: 'identifier',
    primary: [
      { docId: 'wcag22', heading: 'Success Criterion 2.5.8' },
      { docId: 'understanding/target-size-minimum', heading: 'In Brief' },
    ],
    related: [{ docId: 'understanding/target-size-minimum' }],
  },
  {
    id: 'sc-3-3-8',
    question: 'What does 3.3.8 Accessible Authentication (Minimum) require?',
    kind: 'identifier',
    primary: [
      { docId: 'wcag22', heading: 'Success Criterion 3.3.8' },
      { docId: 'understanding/accessible-authentication-minimum', heading: 'In Brief' },
    ],
    related: [{ docId: 'understanding/accessible-authentication-minimum' }],
  },
  {
    id: 'ratio-4-5-1',
    question: 'Which criterion requires a contrast ratio of 4.5:1?',
    kind: 'identifier',
    primary: [
      { docId: 'wcag22', heading: 'Success Criterion 1.4.3' },
      { docId: 'understanding/contrast-minimum', heading: 'In Brief' },
    ],
    related: [{ docId: 'understanding/contrast-minimum' }],
    note: 'A literal ratio. The tokenizer has to keep 4.5 intact for this to be findable.',
  },
  {
    id: 'sc-1-3-5',
    question: 'What input purposes must be programmatically identified under 1.3.5?',
    kind: 'identifier',
    primary: [
      { docId: 'wcag22', heading: 'Success Criterion 1.3.5' },
      { docId: 'understanding/identify-input-purpose', heading: 'In Brief' },
    ],
    related: [{ docId: 'understanding/identify-input-purpose' }],
  },
  {
    id: 'sc-2-4-7',
    question: 'What does 2.4.7 Focus Visible require?',
    kind: 'identifier',
    primary: [
      { docId: 'wcag22', heading: 'Success Criterion 2.4.7' },
      { docId: 'understanding/focus-visible', heading: 'In Brief' },
    ],
    related: [{ docId: 'understanding/focus-visible' }],
  },
  {
    id: 'fieldset-legend',
    question: 'When should checkboxes be wrapped in a fieldset with a legend?',
    kind: 'identifier',
    primary: [
      { docId: 'govuk/components/checkboxes', heading: 'Checkboxes' },
      { docId: 'govuk/components/fieldset', heading: 'Fieldset' },
    ],
    note: 'HTML element names, which survive in the prose even though code examples were dropped.',
  },

  // ── conceptual ────────────────────────────────────────────────────────────
  {
    id: 'large-text-contrast',
    question: 'How much colour contrast does large text need?',
    kind: 'conceptual',
    primary: [
      { docId: 'understanding/contrast-minimum', heading: 'In Brief' },
      { docId: 'understanding/contrast-minimum', heading: 'Situation A' },
    ],
  },
  {
    id: 'colour-alone',
    question: 'Can I use colour on its own to show which answer is wrong?',
    kind: 'conceptual',
    primary: [
      { docId: 'understanding/use-of-color', heading: 'In Brief' },
      { docId: 'understanding/use-of-color', heading: 'Intent' },
    ],
  },
  {
    id: 'keyboard-trap',
    question: 'What counts as trapping someone who is navigating by keyboard?',
    kind: 'conceptual',
    primary: [
      { docId: 'understanding/no-keyboard-trap', heading: 'In Brief' },
      { docId: 'understanding/no-keyboard-trap', heading: 'Intent' },
    ],
  },
  {
    id: 'session-timeout',
    question: 'How much warning do users need before a session expires?',
    kind: 'conceptual',
    primary: [
      { docId: 'understanding/timeouts', heading: 'In Brief' },
      { docId: 'understanding/timing-adjustable', heading: 'In Brief' },
    ],
  },
  {
    id: 'decorative-images',
    question: 'Do images that are purely decorative need a text alternative?',
    kind: 'conceptual',
    primary: [
      { docId: 'understanding/non-text-content', heading: 'In Brief' },
      { docId: 'understanding/non-text-content', heading: 'Situation F' },
    ],
  },
  {
    id: 'focus-indicator-appearance',
    question: 'What should a visible focus indicator actually look like?',
    kind: 'conceptual',
    primary: [
      { docId: 'understanding/focus-appearance', heading: 'In Brief' },
      { docId: 'understanding/focus-visible', heading: 'In Brief' },
    ],
  },
  {
    id: 'error-identification',
    question: 'When a form is submitted with a mistake, what has to be told to the user?',
    kind: 'conceptual',
    primary: [
      { docId: 'understanding/error-identification', heading: 'In Brief' },
      { docId: 'understanding/error-identification', heading: 'Intent' },
    ],
  },
  {
    id: 'label-in-name',
    question: 'Why does the accessible name have to contain the visible label text?',
    kind: 'conceptual',
    primary: [
      { docId: 'understanding/label-in-name', heading: 'In Brief' },
      { docId: 'understanding/label-in-name', heading: 'Intent' },
    ],
  },
  {
    id: 'page-titles',
    question: 'How should the title of a page be written?',
    kind: 'conceptual',
    primary: [
      { docId: 'understanding/page-titled', heading: 'In Brief' },
      { docId: 'understanding/page-titled', heading: 'Intent' },
    ],
  },
  {
    id: 'reflow',
    question: 'Does content have to work without scrolling sideways on a narrow screen?',
    kind: 'conceptual',
    primary: [
      { docId: 'understanding/reflow', heading: 'In Brief' },
      { docId: 'understanding/reflow', heading: 'Intent' },
    ],
  },
  {
    id: 'live-captions',
    question: 'Are captions needed for video that is streamed live?',
    kind: 'conceptual',
    primary: [
      { docId: 'understanding/captions-live', heading: 'In Brief' },
    ],
  },
  {
    id: 'heading-structure',
    question: 'How should headings convey the structure of a page?',
    kind: 'conceptual',
    primary: [
      { docId: 'understanding/headings-and-labels', heading: 'In Brief' },
      { docId: 'understanding/info-and-relationships', heading: 'In Brief' },
    ],
  },
  {
    id: 'text-spacing',
    question: 'Which spacing settings must a user be able to change without losing content?',
    kind: 'conceptual',
    primary: [
      { docId: 'understanding/text-spacing', heading: 'In Brief' },
      { docId: 'understanding/text-spacing', heading: 'Intent' },
    ],
  },
  {
    id: 'flashing',
    question: 'How many times a second is content allowed to flash?',
    kind: 'conceptual',
    primary: [{ docId: 'understanding/three-flashes-or-below-threshold', heading: 'In Brief' }],
  },
  {
    id: 'bypass-blocks',
    question: 'What is a mechanism for skipping repeated navigation?',
    kind: 'conceptual',
    primary: [
      { docId: 'understanding/bypass-blocks', heading: 'In Brief' },
      { docId: 'understanding/bypass-blocks', heading: 'Intent' },
    ],
  },
  {
    id: 'page-language',
    question: 'How is the language of a page made available to assistive technology?',
    kind: 'conceptual',
    primary: [
      { docId: 'understanding/language-of-page', heading: 'In Brief' },
    ],
  },
  {
    id: 'audio-description',
    question: 'When does a prerecorded video need an audio description?',
    kind: 'conceptual',
    primary: [
      { docId: 'understanding/audio-description-or-media-alternative-prerecorded', heading: 'In Brief' },
    ],
  },

  // ── design system ─────────────────────────────────────────────────────────
  {
    id: 'radios-vs-checkboxes',
    question: 'Should I use radios or checkboxes when only one answer is allowed?',
    kind: 'design',
    primary: [
      { docId: 'govuk/components/radios', heading: 'Radios' },
      { docId: 'govuk/components/checkboxes', heading: 'Checkboxes' },
    ],
  },
  {
    id: 'error-summary',
    question: 'Where should the summary of form errors go on the page?',
    kind: 'design',
    primary: [{ docId: 'govuk/components/error-summary', heading: 'Error summary' }],
  },
  {
    id: 'exit-this-page',
    question: 'What is the exit this page component for?',
    kind: 'design',
    primary: [{ docId: 'govuk/components/exit-this-page', heading: 'Exit this page' }],
  },
  {
    id: 'preselect-checkboxes',
    question: 'Is it alright to pre-select checkbox options for the user?',
    kind: 'design',
    primary: [{ docId: 'govuk/components/checkboxes', heading: 'Checkboxes' }],
  },
  {
    id: 'asking-for-dates',
    question: 'What is the recommended way to ask someone for a date of birth?',
    kind: 'design',
    primary: [
      { docId: 'govuk/patterns/dates', heading: 'Dates' },
      { docId: 'govuk/components/date-input', heading: 'Date input' },
    ],
  },
  {
    id: 'skip-link',
    question: 'What does a skip link do and where does it belong?',
    kind: 'design',
    primary: [{ docId: 'govuk/components/skip-link', heading: 'Skip link' }],
  },

  // ── refusal ───────────────────────────────────────────────────────────────
  {
    id: 'refusal-en301549',
    question: 'Which clause of EN 301 549 covers web content?',
    kind: 'refusal',
    primary: [],
    note: 'EN 301 549 was deliberately left out of the corpus. Adjacent vocabulary, no answer.',
  },
  {
    id: 'refusal-kubernetes',
    question: 'How do I configure a Kubernetes ingress controller?',
    kind: 'refusal',
    primary: [],
    note: 'Entirely off-domain. The easy refusal — if this one fails, nothing else matters.',
  },
  {
    id: 'refusal-wcag3',
    question: 'What conformance model does WCAG 3.0 use?',
    kind: 'refusal',
    primary: [],
    note: 'Near-miss: the corpus is full of WCAG conformance language, none of it about 3.0.',
  },
  {
    id: 'refusal-cost',
    question: 'How much does a WCAG accessibility audit cost?',
    kind: 'refusal',
    primary: [],
    note: 'Plausible question, on-topic vocabulary, no factual basis anywhere in the corpus.',
  },
  {
    id: 'refusal-react-hook',
    question: 'Which React hook should I use to manage focus?',
    kind: 'refusal',
    primary: [],
    note: 'The corpus talks about focus constantly, and about React never.',
  },
];
