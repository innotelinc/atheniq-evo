/**
 * The institution's catalog: programs, courses, terms, faculty and the copy the
 * public site is built from.
 *
 * This is content, not configuration. It changes when the institution changes
 * what it teaches — not when a host or a key changes.
 */

export type ProgramLevel = "Undergraduate" | "Graduate" | "Professional";

export interface Course {
  code: string;
  /** The Open edX course key this course maps to. */
  key: string;
  title: string;
  credits: number;
  termId: string;
  instructor: string;
  format: string;
  summary: string;
  seats: number;
  weeks: number;
}

export interface Program {
  slug: string;
  name: string;
  credential: string;
  level: ProgramLevel;
  duration: string;
  credits: number;
  format: string;
  tuition: number;
  tuitionUnit: "year" | "program";
  tuitionNote: string;
  summary: string;
  overview: string[];
  outcomes: string[];
  curriculum: { term: string; courses: string[] }[];
  careers: string[];
  cohort: string;
}

export interface Term {
  id: string;
  name: string;
  /** ISO 8601 dates (YYYY-MM-DD), interpreted in UTC. */
  starts: string;
  ends: string;
  applicationsOpen: string;
  applicationsPriority: string;
  applicationsClose: string;
  registrationCloses: string;
  /**
   * `open` accepts registrations until `registrationCloses`; `waitlist` records
   * interest; `closed` does not. The date is enforced either way.
   */
  registration: "open" | "waitlist" | "closed";
  intake: boolean;
}

export interface FacultyMember {
  name: string;
  role: string;
  field: string;
  bio: string;
  initials: string;
}

export const TERMS: Term[] = [
  {
    id: "2027A",
    name: "Fall 2027",
    starts: "2027-09-14",
    ends: "2027-12-17",
    applicationsOpen: "2026-09-01",
    applicationsPriority: "2027-01-15",
    applicationsClose: "2027-04-30",
    registrationCloses: "2027-08-28",
    registration: "open",
    intake: true,
  },
  {
    id: "2028B",
    name: "Spring 2028",
    starts: "2028-01-11",
    ends: "2028-03-31",
    applicationsOpen: "2027-05-01",
    applicationsPriority: "2027-10-15",
    applicationsClose: "2027-12-04",
    registrationCloses: "2027-12-04",
    registration: "open",
    intake: true,
  },
  {
    id: "2028C",
    name: "Summer 2028",
    starts: "2028-04-24",
    ends: "2028-07-07",
    applicationsOpen: "2028-01-10",
    applicationsPriority: "2028-02-15",
    applicationsClose: "2028-03-20",
    registrationCloses: "2028-03-20",
    registration: "waitlist",
    intake: false,
  },
];

const DAY_MS = 86_400_000;

function utcMidnight(iso: string): number {
  const value = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(value)) throw new Error(`content.ts: ${iso} is not an ISO date`);
  return value;
}

function endOfUtcDay(iso: string): number {
  return utcMidnight(iso) + DAY_MS - 1;
}

/** A long, stable date for copy and errors: "September 14, 2027". */
export function formatDate(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

export type ApplicationState = "not-accepting" | "before" | "open" | "after";

/** Applications run from the start of `applicationsOpen` through the end of `applicationsClose`, UTC. */
export function applicationState(term: Term, now: Date = new Date()): ApplicationState {
  if (!term.intake) return "not-accepting";
  const time = now.getTime();
  if (time < utcMidnight(term.applicationsOpen)) return "before";
  if (time > endOfUtcDay(term.applicationsClose)) return "after";
  return "open";
}

export type RegistrationState = "open" | "waitlist" | "closed" | "past-deadline";

export function registrationState(term: Term, now: Date = new Date()): RegistrationState {
  if (term.registration === "waitlist") return "waitlist";
  if (term.registration === "closed") return "closed";
  if (now.getTime() > endOfUtcDay(term.registrationCloses)) return "past-deadline";
  return "open";
}

export function openApplicationTerms(now: Date = new Date()): Term[] {
  return TERMS.filter((term) => applicationState(term, now) === "open");
}

/**
 * The intake the site should talk about: one accepting applications now, else
 * the next to open, else the most recently closed intake.
 */
export function applicationCycle(now: Date = new Date()): Term {
  const open = TERMS.find((term) => applicationState(term, now) === "open");
  if (open) return open;
  const upcoming = TERMS.filter((term) => applicationState(term, now) === "before").sort((a, b) =>
    a.applicationsOpen.localeCompare(b.applicationsOpen),
  )[0];
  if (upcoming) return upcoming;
  const latest = TERMS.filter((term) => term.intake).sort((a, b) =>
    b.applicationsClose.localeCompare(a.applicationsClose),
  )[0];
  if (!latest) throw new Error("content.ts: the institution has no intake terms");
  return latest;
}

export function applicationWindowLabel(term: Term): string {
  return `${formatDate(term.applicationsOpen)} – ${formatDate(term.applicationsClose)}; priority ${formatDate(term.applicationsPriority)}`;
}

export function registrationLabel(term: Term, now: Date = new Date()): string {
  const state = registrationState(term, now);
  if (state === "open") return `open until ${formatDate(term.registrationCloses)}`;
  if (state === "past-deadline") return `closed ${formatDate(term.registrationCloses)}`;
  return state;
}

export const COURSES: Course[] = [
  {
    code: "AI101",
    key: "course-v1:AthenIQ+AI101+2027A",
    title: "Foundations of Machine Intelligence",
    credits: 15,
    termId: "2027A",
    instructor: "Dr. Amara Okonjo",
    format: "Studio · 12 weeks",
    summary:
      "What learning systems actually do: representation, search, optimisation and the assumptions behind a model. Built around weekly problem studios rather than lectures.",
    seats: 36,
    weeks: 12,
  },
  {
    code: "AI102",
    key: "course-v1:AthenIQ+AI102+2027A",
    title: "Programming for Learning Systems",
    credits: 15,
    termId: "2027A",
    instructor: "Prof. Elias Varga",
    format: "Studio · 12 weeks",
    summary:
      "Write the systems you will later reason about. Data pipelines, numerical computing, testing and the engineering habits that make an experiment repeatable.",
    seats: 40,
    weeks: 12,
  },
  {
    code: "AI210",
    key: "course-v1:AthenIQ+AI210+2027A",
    title: "Data Systems at Scale",
    credits: 15,
    termId: "2027A",
    instructor: "Prof. Noah Adeyemi",
    format: "Studio · 12 weeks",
    summary:
      "Storage, indexing, streaming and the cost of consistency. Students build and operate a small warehouse, then explain every trade-off in it.",
    seats: 28,
    weeks: 12,
  },
  {
    code: "AI220",
    key: "course-v1:AthenIQ+AI220+2027A",
    title: "Human–AI Interaction",
    credits: 15,
    termId: "2027A",
    instructor: "Dr. Sofia Marchetti",
    format: "Seminar + studio · 12 weeks",
    summary:
      "Interfaces for systems that are uncertain, generative and sometimes wrong. Evaluation with real users, not intuition.",
    seats: 30,
    weeks: 12,
  },
  {
    code: "GV101",
    key: "course-v1:AthenIQ+GV101+2027A",
    title: "Regulation of Automated Systems",
    credits: 15,
    termId: "2027A",
    instructor: "Prof. Ruth Kessler",
    format: "Seminar · 12 weeks",
    summary:
      "How law, procurement and standards shape what gets built. Casework from credit, health, employment and public administration.",
    seats: 45,
    weeks: 12,
  },
  {
    code: "DS101",
    key: "course-v1:AthenIQ+DS101+2027A",
    title: "Data Engineering Foundations",
    credits: 15,
    termId: "2027A",
    instructor: "Prof. Noah Adeyemi",
    format: "Studio · 12 weeks",
    summary:
      "The unglamorous half of every model: ingestion, schemas, lineage, quality and the on-call discipline that keeps a pipeline honest.",
    seats: 35,
    weeks: 12,
  },
  {
    code: "AI201",
    key: "course-v1:AthenIQ+AI201+2028B",
    title: "Probability and Inference",
    credits: 15,
    termId: "2028B",
    instructor: "Dr. Mei Lin Tan",
    format: "Studio · 12 weeks",
    summary:
      "Probability as a language for uncertainty, from estimation to causal claims. Every result is implemented and stress-tested against a counterexample.",
    seats: 32,
    weeks: 12,
  },
  {
    code: "AI301",
    key: "course-v1:AthenIQ+AI301+2028B",
    title: "Deep Learning Systems",
    credits: 20,
    termId: "2028B",
    instructor: "Dr. Amara Okonjo",
    format: "Studio · 12 weeks",
    summary:
      "Train, evaluate and serve modern networks. Attention, optimisation, data curation and the failure modes that benchmarks hide.",
    seats: 24,
    weeks: 12,
  },
  {
    code: "PT101",
    key: "course-v1:AthenIQ+PT101+2028B",
    title: "Public Interest Technology",
    credits: 15,
    termId: "2028B",
    instructor: "Dr. Sofia Marchetti",
    format: "Seminar + placement · 12 weeks",
    summary:
      "Build with a public partner on a real constraint: eligibility, casework, accessibility or procurement. Delivered with a supervised placement.",
    seats: 30,
    weeks: 12,
  },
  {
    code: "AI310",
    key: "course-v1:AthenIQ+AI310+2028B",
    title: "AI Governance and Accountability",
    credits: 15,
    termId: "2028B",
    instructor: "Prof. Ruth Kessler",
    format: "Seminar · 12 weeks",
    summary:
      "Turn a principle into an auditable practice: impact assessment, documentation, incident response and the evidence a regulator will ask for.",
    seats: 40,
    weeks: 12,
  },
  {
    code: "AI320",
    key: "course-v1:AthenIQ+AI320+2028C",
    title: "Capstone Studio I",
    credits: 20,
    termId: "2028C",
    instructor: "Prof. Elias Varga",
    format: "Studio · 10 weeks",
    summary:
      "A scoped, supervised build with an external partner. The first half of the capstone: problem framing, ethics review, architecture and a working prototype.",
    seats: 18,
    weeks: 10,
  },
  {
    code: "AI400",
    key: "course-v1:AthenIQ+AI400+2028C",
    title: "Capstone Studio II",
    credits: 30,
    termId: "2028C",
    instructor: "Dr. Amara Okonjo",
    format: "Studio · 10 weeks",
    summary:
      "Ship it, evaluate it and defend it. A public demonstration, a written evaluation and an oral defense before two faculty and one external examiner.",
    seats: 18,
    weeks: 10,
  },
  {
    code: "PT201",
    key: "course-v1:AthenIQ+PT201+2028C",
    title: "Policy Lab",
    credits: 20,
    termId: "2028C",
    instructor: "Prof. Ruth Kessler",
    format: "Lab · 10 weeks",
    summary:
      "Draft an instrument — a standard, a procurement clause, an audit method — and test it against the people who would have to live with it.",
    seats: 20,
    weeks: 10,
  },
];

export const PROGRAMS: Program[] = [
  {
    slug: "bsc-applied-ai",
    name: "Applied Artificial Intelligence",
    credential: "BS",
    level: "Undergraduate",
    duration: "3 years, full-time",
    credits: 360,
    format: "Online-first studio teaching, with two residential intensives a year",
    tuition: 12_000,
    tuitionUnit: "year",
    tuitionNote: "Per year. Income-based aid and merit scholarships are available.",
    summary:
      "A three-year degree for people who want to build learning systems, not just call them. Foundations in mathematics and engineering, then a year of studio work with real partners.",
    overview: [
      "The degree begins with the things that do not change: probability, computation, data and the behavior of complex systems. Only once those are solid does the curriculum move to modern machine learning — because a model you cannot explain is a model you cannot audit, defend or repair.",
      "Teaching happens in studios of no more than eighteen. You write code every week, present it every fortnight, and are examined on what you can build and justify rather than what you can recall. Two residential weeks a year bring the cohort together for intensive critique.",
      "The final year is a supervised capstone with an external partner: a public body, a research group or a company willing to expose a real constraint. You graduate with a portfolio, a written evaluation and an oral defense on record.",
    ],
    outcomes: [
      "Design, train and evaluate learning systems against a stated baseline.",
      "Read a dataset and a claim critically, and say what would falsify it.",
      "Build data infrastructure that another engineer can operate and audit.",
      "Explain a model's limits to a non-technical decision-maker.",
      "Work to a professional standard: versioned, tested, documented, reproducible.",
    ],
    curriculum: [
      { term: "Year 1 · Term 1", courses: ["AI101", "AI102"] },
      { term: "Year 1 · Term 2", courses: ["AI201", "AI210"] },
      { term: "Year 2 · Term 1", courses: ["AI301", "AI220"] },
      { term: "Year 2 · Term 2", courses: ["DS101", "GV101"] },
      { term: "Year 3 · Term 1", courses: ["AI320", "PT101"] },
      { term: "Year 3 · Term 2", courses: ["AI400"] },
    ],
    careers: [
      "Machine learning engineer",
      "Data platform engineer",
      "Research assistant",
      "Product engineer for AI systems",
      "Further study (MSc or PhD)",
    ],
    cohort: "Cohorts of 60, studios of 18",
  },
  {
    slug: "msc-machine-intelligence",
    name: "Machine Intelligence",
    credential: "MSc",
    level: "Graduate",
    duration: "12 months, full-time · 24 months, part-time",
    credits: 180,
    format: "Online-first studio teaching, with one residential intensive",
    tuition: 18_500,
    tuitionUnit: "program",
    tuitionNote: "Total program fee. Paid in three installments; scholarships available.",
    summary:
      "One year for engineers and scientists who want depth: modern learning systems, evaluation that survives contact with users, and a capstone that has to work.",
    overview: [
      "The MSc assumes you can already program. It spends its time on the parts that separate a working prototype from a system you would put in front of people: inference under uncertainty, data curation, evaluation design, serving and monitoring.",
      "Every module is assessed through a build and a defense. There are no unseen written examinations. Instead you present your work to faculty and peers, answer for the choices you made, and revise.",
      "The capstone is twelve weeks with an external partner, examined by two faculty and one external examiner. Recent partners have included a public health agency, a court service and two early-stage research companies.",
    ],
    outcomes: [
      "Formulate a research or product question as a testable machine-learning problem.",
      "Design an evaluation that measures the thing that matters, including its harms.",
      "Serve and monitor a model in production with a credible rollback plan.",
      "Write and defend a technical argument to expert and lay audiences.",
    ],
    curriculum: [
      { term: "Term 1 · Foundations", courses: ["AI201", "AI301"] },
      { term: "Term 2 · Systems and society", courses: ["AI220", "AI310", "DS101"] },
      { term: "Term 3 · Capstone", courses: ["AI320", "AI400"] },
    ],
    careers: [
      "Senior machine learning engineer",
      "Applied research scientist",
      "AI evaluation lead",
      "Technical founder",
    ],
    cohort: "Cohorts of 40, studios of 16",
  },
  {
    slug: "mpt-public-interest-tech",
    name: "Public Interest Technology",
    credential: "MPT",
    level: "Graduate",
    duration: "16 months, full-time",
    credits: 180,
    format: "Seminars, a supervised placement and a policy lab",
    tuition: 16_000,
    tuitionUnit: "program",
    tuitionNote: "Total program fee. Placement travel is covered by the Institute.",
    summary:
      "For people who will sit on both sides of the table: building systems for public institutions, and writing the rules those systems have to meet.",
    overview: [
      "Most AI failures in public services are not model failures. They are failures of specification, procurement, accessibility and accountability. This program is built around those.",
      "Students spend a term embedded with a public partner, working on a live constraint under supervision. The placement is assessed on the usefulness of the work to the partner, not on a report about it.",
      "The policy lab asks you to draft an instrument that others would have to follow — a standard, a clause, an audit method — and then test it against the people who would live with it.",
    ],
    outcomes: [
      "Specify and procure an automated system for a public body.",
      "Conduct an impact assessment that a regulator would accept as evidence.",
      "Design accessible services with and for affected communities.",
      "Evaluate a vendor's claims independently.",
    ],
    curriculum: [
      { term: "Term 1 · Public systems", courses: ["PT101", "GV101"] },
      { term: "Term 2 · Interaction and accountability", courses: ["AI220", "AI310"] },
      { term: "Term 3 · Policy lab", courses: ["PT201"] },
      { term: "Term 4 · Capstone", courses: ["AI320"] },
    ],
    careers: [
      "Policy lead for AI and data",
      "Public-sector technology advisor",
      "Service design lead",
      "Regulatory technologist",
    ],
    cohort: "Cohorts of 24",
  },
  {
    slug: "pgcert-ai-governance",
    name: "AI Governance",
    credential: "Graduate Certificate",
    level: "Professional",
    duration: "8 months, part-time",
    credits: 60,
    format: "Evening seminars, online, with one residential weekend",
    tuition: 4_800,
    tuitionUnit: "program",
    tuitionNote: "Total program fee. Employer invoicing available.",
    summary:
      "A part-time certificate for people who have to make AI accountable inside an organization: assessment, documentation, incident response and audit.",
    overview: [
      "Designed for working professionals in compliance, product, engineering and policy. Two evening seminars a week for eight months, plus one residential weekend.",
      "You leave with a working accountability pack for your own organization: an impact assessment method, a documentation standard, an incident playbook and an audit trail you can defend.",
      "Teaching is case-led. Every session starts with a real decision someone had to make, and ends with what evidence would have made it better.",
    ],
    outcomes: [
      "Run a proportionate impact assessment for an automated system.",
      "Write documentation that survives an external audit.",
      "Lead an incident response and post-incident review.",
      "Translate regulatory expectations into engineering practice.",
    ],
    curriculum: [
      { term: "Term 1 · Foundations", courses: ["GV101", "AI310"] },
      { term: "Term 2 · Practice", courses: ["PT201"] },
    ],
    careers: [
      "AI governance lead",
      "Responsible AI program manager",
      "Compliance and audit specialist",
      "Policy advisor",
    ],
    cohort: "Cohorts of 45",
  },
];

export const FACULTY: FacultyMember[] = [
  {
    name: "Dr. Amara Okonjo",
    role: "Dean of Faculty",
    field: "Machine learning systems",
    bio: "Twenty years building and auditing learning systems in health and education. Teaches deep learning and the capstone.",
    initials: "AO",
  },
  {
    name: "Prof. Elias Varga",
    role: "Director of Studio Teaching",
    field: "Software engineering",
    bio: "Engineer and teacher. Designs the studio method and the capstone's external-partner program.",
    initials: "EV",
  },
  {
    name: "Dr. Mei Lin Tan",
    role: "Faculty, Mathematics",
    field: "Probability and causal inference",
    bio: "Works on uncertainty and causal claims in observational data. Teaches probability and inference.",
    initials: "MT",
  },
  {
    name: "Prof. Ruth Kessler",
    role: "Faculty, Governance",
    field: "Regulation and accountability",
    bio: "Former regulator. Teaches regulation, governance and the policy lab.",
    initials: "RK",
  },
  {
    name: "Dr. Sofia Marchetti",
    role: "Faculty, Interaction",
    field: "Human–AI interaction",
    bio: "Designs and evaluates interfaces for uncertain systems, with a focus on accessibility.",
    initials: "SM",
  },
  {
    name: "Prof. Noah Adeyemi",
    role: "Faculty, Data Systems",
    field: "Data engineering",
    bio: "Builds and operates data infrastructure at scale. Teaches data systems and engineering foundations.",
    initials: "NA",
  },
];

export const PRINCIPLES = [
  {
    title: "Small by design",
    body: "Cohorts are capped and studios never exceed eighteen. Every student is known by name to the person teaching them.",
  },
  {
    title: "Build, then defend",
    body: "Assessment is a working artefact and an oral defense. You are examined on what you can justify, not what you can recall.",
  },
  {
    title: "AI in the room",
    body: "Every course runs alongside an AI classroom that knows the material and the learner. It is a tool for practice, never the examiner.",
  },
  {
    title: "Credentials you can check",
    body: "Awards are signed and issued through Signara. Anyone can verify a certificate or degree from its identifier.",
  },
];

export const STATS = [
  { value: "6 : 1", label: "student–faculty ratio" },
  { value: "18", label: "maximum studio size" },
  { value: "24", label: "countries represented" },
  { value: "3", label: "intakes each year" },
];

export interface TimelineEntry {
  date: string;
  title: string;
  body: string;
}

/** The admissions calendar, generated from the term's dates. */
export function timelineFor(term: Term): TimelineEntry[] {
  return [
    {
      date: formatDate(term.applicationsOpen),
      title: "Applications open",
      body: "Choose a program, write a short statement and submit. There is no application fee.",
    },
    {
      date: formatDate(term.applicationsPriority),
      title: "Priority deadline",
      body: "Priority applicants are interviewed first and considered for every scholarship round.",
    },
    {
      date: `${formatDate(term.applicationsPriority)} – ${formatDate(term.applicationsClose)}`,
      title: "Interviews and decisions",
      body: "A 30-minute conversation with a member of faculty. Decisions are issued within three weeks.",
    },
    {
      date: `${formatDate(term.applicationsClose)} – ${formatDate(term.starts)}`,
      title: "Enrollment and account issuance",
      body: `Accept your offer, pay the first installment, and receive your student number and @atheniq.institute address. Registration closes ${formatDate(term.registrationCloses)}.`,
    },
    {
      date: formatDate(term.starts),
      title: `${term.name} begins`,
      body: "Orientation week, then studios.",
    },
  ];
}

export const FAQ = [
  {
    question: "Is AthenIQ Institute accredited?",
    answer:
      "AthenIQ Institute is a new institution. We operate under our own published academic quality framework and are in the process of seeking recognition from an external accrediting body. We will publish the outcome and the body's name here when it is settled, rather than implying a status we do not yet hold. Every award is externally examinable and independently verifiable.",
  },
  {
    question: "Can I study while working?",
    answer:
      "Yes. The MSc runs part-time over 24 months and the governance certificate is designed for working professionals, with evening seminars. The BSc and MPT are full-time programs.",
  },
  {
    question: "Do I need a computer science degree?",
    answer:
      "For the MSc, you need evidence that you can program and handle quantitative work: a technical degree, a strong portfolio, or relevant professional experience. The admissions conversation is designed to establish that, not to filter on the name of your degree.",
  },
  {
    question: "How does the AI classroom work?",
    answer:
      "Each course has an AI classroom that can explain, question and set practice against the course's own material. It knows which learner is present because the Institute signs a short-lived identity token when you enter from your student portal. It reports completion back to the academic record, and it never awards a credential on its own.",
  },
  {
    question: "What do I receive when I enroll?",
    answer:
      "A student number, a student account on this portal, and an @atheniq.institute email address. The address is reserved in the Institute directory at admission and activated by our mail provider.",
  },
  {
    question: "Can anyone verify my credential?",
    answer:
      "Yes. Every certificate and degree carries a verification identifier. Verification is handled by the Institute's signing service, so a third party can confirm the award without an account here.",
  },
];

export function programBySlug(slug: string): Program | undefined {
  return PROGRAMS.find((program) => program.slug === slug);
}

export function courseByCode(code: string): Course | undefined {
  return COURSES.find((course) => course.code === code);
}

export function termById(id: string): Term | undefined {
  return TERMS.find((term) => term.id === id);
}

export function intakeTerms(): Term[] {
  return TERMS.filter((term) => term.intake);
}

export function programsForCourse(code: string): Program[] {
  return PROGRAMS.filter((program) =>
    program.curriculum.some((block) => block.courses.includes(code)),
  );
}
