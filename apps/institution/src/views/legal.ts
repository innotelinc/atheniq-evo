/**
 * Privacy, terms and accessibility.
 *
 * These pages are written once and linked from the application consent and the
 * footer. They describe what the code actually does — the session cookie, the
 * scrypt hashes, the retention window — so a change in behavior is a change to
 * this file, not a paragraph nobody owns.
 */

import { esc, layout, pageHead, type UiContext } from "../ui.ts";

const EFFECTIVE = "November 20, 2026";

interface LegalSection {
  id: string;
  heading: string;
  /** Static copy written in this file; nothing visitor-supplied is interpolated unescaped. */
  body: string;
}

interface LegalInput {
  title: string;
  eyebrow: string;
  lede: string;
  description: string;
  facts: { label: string; value: string }[];
  sections: LegalSection[];
  asideTitle: string;
  asideBody: string;
  contactEmail: string;
  contactLabel: string;
}

function legalDocument(ctx: UiContext, input: LegalInput): string {
  const body = `
  ${pageHead({
    eyebrow: input.eyebrow,
    title: input.title,
    lede: input.lede,
    facts: input.facts,
  })}

  <section class="section">
    <div class="shell split">
      <div class="prose">
        ${input.sections
          .map((section) => `<h2 id="${esc(section.id)}">${esc(section.heading)}</h2>${section.body}`)
          .join("")}
      </div>
      <aside class="panel panel--sticky">
        <p class="eyebrow">On this page</p>
        <h2>${esc(input.asideTitle)}</h2>
        <ul>
          ${input.sections.map((section) => `<li><a href="#${esc(section.id)}">${esc(section.heading)}</a></li>`).join("")}
        </ul>
        <p class="form-note">${esc(input.asideBody)}</p>
        <a class="button button--ghost" href="mailto:${esc(input.contactEmail)}">${esc(input.contactLabel)}</a>
      </aside>
    </div>
  </section>`;

  return layout({
    title: input.title,
    description: input.description,
    surface: "public",
    ctx,
    body,
  });
}

export function privacy(ctx: UiContext): string {
  const domain = esc(ctx.mailDomain);
  return legalDocument(ctx, {
    title: "Privacy notice",
    eyebrow: "Legal",
    lede: "What the Institute collects when you apply, enroll and learn, why we keep it, and what you can ask us to do with it.",
    description: "How AthenIQ Institute collects, uses and retains personal data.",
    facts: [
      { label: "Effective", value: EFFECTIVE },
      { label: "Applies to", value: "atheniq.institute and registrar.atheniq.institute" },
      { label: "Contact", value: `privacy@${ctx.mailDomain}` },
    ],
    contactEmail: `privacy@${ctx.mailDomain}`,
    contactLabel: "Contact the privacy office",
    asideTitle: "Your data, in plain language.",
    asideBody:
      "This notice covers the public site, admissions, the student portal and the registrar. It does not replace the student handbook or the terms of any service you use through the Institute.",
    sections: [
      {
        id: "collect",
        heading: "What we collect",
        body: `<p>We collect only what the Institute needs to admit, enroll and teach you:</p>
<ul>
<li><strong>Applications:</strong> your name, email address, country, program and intake choices, and the statement you write.</li>
<li><strong>Student account:</strong> your student number, AthenIQ email address, a scrypt hash of your password, and the state of your mailbox.</li>
<li><strong>Enrollment:</strong> the courses you register for, the term, and your registration status.</li>
<li><strong>Instruction:</strong> completion records reported by the AI classroom (course, score, outcomes) and your academic record in the learning system.</li>
<li><strong>Operations:</strong> server logs with IP address, request id, timestamps and the pages requested, and any support email you send us.</li>
</ul>
<p>We do not collect payment card data on this site. Fees are invoiced separately.</p>`,
      },
      {
        id: "why",
        heading: "Why we use it",
        body: `<ul>
<li>Review your application and make an admissions decision.</li>
<li>Issue and administer your student account, student number and email address.</li>
<li>Register you for courses and deliver instruction.</li>
<li>Record completions and issue credentials.</li>
<li>Protect the service: detect abuse, investigate security incidents, and keep audit records.</li>
<li>Meet legal, tax and accreditation obligations that apply to the Institute.</li>
<li>Produce aggregate reporting, such as completion rates, that does not identify you.</li>
</ul>
<p>Where the law requires a legal basis, we rely on performing our agreement with you, our legitimate interest in running the Institute, your consent where we ask for it, and legal obligation where applicable.</p>`,
      },
      {
        id: "cookies",
        heading: "Cookies and tracking",
        body: `<p>This site sets one session cookie per surface. It is HttpOnly, SameSite=Lax, expires after eight hours, and is marked Secure in production. It contains a signed session identifier and your account id, not your password.</p>
<p>We do not use advertising cookies, analytics tags, pixels or third-party scripts. The only JavaScript on the public site adds a scroll reveal and a character counter; the site works without it.</p>`,
      },
      {
        id: "sharing",
        heading: "Who we share it with",
        body: `<p>The Institute uses service providers to run the estate:</p>
<ul>
<li><strong>Open edX</strong> for courseware, progress and the gradebook.</li>
<li><strong>OpenMAIC and the AthenIQ bridge</strong> for AI classroom instruction and completion records.</li>
<li><strong>Signara</strong> to sign and issue credentials.</li>
<li><strong>A mail provider</strong> to deliver mail to your <span class="code">@${domain}</span> address, once connected.</li>
<li><strong>Hosting and infrastructure providers</strong> that store the registry and serve this site.</li>
</ul>
<p>They process data on our instructions and under contract. We do not sell personal data. We disclose it to authorities only when the law requires it, and we tell you unless we are prohibited from doing so.</p>`,
      },
      {
        id: "retention",
        heading: "How long we keep it",
        body: `<ul>
<li><strong>Applications not admitted:</strong> 24 months after the intake closes, then deleted or anonymized.</li>
<li><strong>Student records:</strong> for the duration of study and 7 years after your last enrollment, or longer if a legal hold or a credential dispute requires it.</li>
<li><strong>Server logs:</strong> 90 days, unless retained for a security investigation.</li>
<li><strong>Backups:</strong> 35 days.</li>
<li><strong>Passwords:</strong> stored only as salted scrypt hashes. Temporary passwords are never stored in plain text and cannot be recovered.</li>
</ul>`,
      },
      {
        id: "rights",
        heading: "Your choices and rights",
        body: `<p>Depending on where you live, you may have the right to:</p>
<ul>
<li>ask for a copy of the personal data we hold about you;</li>
<li>correct inaccurate data;</li>
<li>ask us to delete data we no longer need, where the law allows;</li>
<li>object to or restrict certain processing;</li>
<li>receive your data in a portable format;</li>
<li>withdraw consent you gave us, for future processing.</li>
</ul>
<p>Write to <a href="mailto:privacy@${domain}">privacy@${domain}</a>. We may ask you to verify your identity. We respond within 30 days. If we cannot meet a request, we will explain why and tell you how to appeal. You may also complain to your local data protection authority.</p>`,
      },
      {
        id: "security",
        heading: "How we protect it",
        body: `<p>We use TLS in transit, scrypt password hashing, role-separated sessions, and least-privilege access to the registry. Staff access is limited to the registrar. No system is perfectly secure; if you believe your account was compromised, contact the registrar immediately.</p>`,
      },
      {
        id: "transfers",
        heading: "Where data is processed",
        body: `<p>The Institute and its providers may process data in countries other than yours. Where that happens, we require contractual safeguards consistent with applicable law. You can ask the privacy office for more detail about where your data is processed.</p>`,
      },
      {
        id: "age",
        heading: "Applicants under 18",
        body: `<p>The Institute admits students aged 16 and older. If you are under 18, we ask for a parent or guardian's consent before enrollment. If you are under 16, do not submit an application; contact the registrar first.</p>`,
      },
      {
        id: "changes",
        heading: "Changes to this notice",
        body: `<p>We update this notice when our practices change and publish the effective date above. If a change materially affects you, we will email enrolled students and post a notice on the portal before it takes effect.</p>`,
      },
      {
        id: "contact",
        heading: "Contact",
        body: `<p><strong>Privacy office</strong><br><a href="mailto:privacy@${domain}">privacy@${domain}</a><br>AthenIQ Institute</p>
<p>For account or enrollment questions, contact <a href="mailto:registrar@${domain}">registrar@${domain}</a>. For the rules that apply to your use of the site, see the <a href="/terms">terms of use</a>.</p>`,
      },
    ],
  });
}

export function terms(ctx: UiContext): string {
  const domain = esc(ctx.mailDomain);
  return legalDocument(ctx, {
    title: "Terms of use",
    eyebrow: "Legal",
    lede: "The rules that apply when you use the Institute's site, apply for admission, hold a student account or register for a course.",
    description: "Terms of use for AthenIQ Institute's public site, student portal and registrar.",
    facts: [
      { label: "Effective", value: EFFECTIVE },
      { label: "Applies to", value: "atheniq.institute and registrar.atheniq.institute" },
      { label: "Contact", value: `registrar@${ctx.mailDomain}` },
    ],
    contactEmail: `registrar@${ctx.mailDomain}`,
    contactLabel: "Contact the registrar",
    asideTitle: "Read this before you apply.",
    asideBody:
      "Your offer letter, the student handbook and the invoice terms also apply. If they conflict with these terms, the more specific document controls for that subject.",
    sections: [
      {
        id: "site",
        heading: "Using this site",
        body: `<p>By using atheniq.institute, the student portal or the registrar, you agree to these terms. If you do not agree, do not use the site.</p>
<p>The site describes the Institute's programs, admissions process, fees and calendar. It is information, not an offer. Program details, dates, fees and faculty may change, and we correct errors when we find them.</p>`,
      },
      {
        id: "applications",
        heading: "Applications",
        body: `<p>You must give accurate information. We may decline or withdraw an offer if an application is false or misleading, or if a required document is not provided.</p>
<p>Submitting an application does not create a student account and does not guarantee admission. There is no application fee. Admission decisions are made by faculty who teach the program.</p>`,
      },
      {
        id: "accounts",
        heading: "Student accounts",
        body: `<p>We issue one student account per admitted student. You are responsible for keeping your password confidential and for activity under your account. Tell the registrar immediately if you believe someone else has access.</p>
<p>We may suspend an account for security, nonpayment, academic misconduct or a breach of these terms. Suspension does not delete your record; the registrar will explain how to resolve it.</p>`,
      },
      {
        id: "registration",
        heading: "Registration and courses",
        body: `<p>A registration holds a seat in the institution registry, subject to prerequisites, minimum enrollment, instructor availability and reconciliation with the learning system. A seat is not final until the registrar confirms it.</p>
<p>If a course is full, the registrar keeps a waitlist. If the Institute cancels a course, we will offer an alternative or refund the fee for that course.</p>`,
      },
      {
        id: "fees",
        heading: "Fees and payment",
        body: `<p>Fees are invoiced by the registrar. This site does not take card payments and does not store payment card data. Payment terms, installment dates and refund rules are stated on the invoice.</p>
<p>If you do not pay by the due date, we may cancel your registration. Scholarships and aid are applied as stated in your offer.</p>`,
      },
      {
        id: "academic",
        heading: "Academic conduct and credentials",
        body: `<p>Academic conduct, assessment and progression are governed by the student handbook provided at enrollment. You are responsible for your work and for following the assessment rules.</p>
<p>The AI classroom is a practice tool. It does not examine you and does not award credentials. Grades and awards are decided by faculty and the registrar. Credentials are signed and issued through the Institute's signing service and may be revoked for fraud, error or a breach of academic conduct rules.</p>`,
      },
      {
        id: "acceptable",
        heading: "Acceptable use",
        body: `<p>You may not:</p>
<ul>
<li>access another student's record or try to bypass authentication;</li>
<li>scrape or copy the site at scale, or use it to send spam;</li>
<li>upload malware or interfere with the service;</li>
<li>impersonate another person or the Institute;</li>
<li>harass staff or students.</li>
</ul>
<p>We may suspend access and report unlawful activity to the appropriate authorities.</p>`,
      },
      {
        id: "intellectual-property",
        heading: "Intellectual property",
        body: `<p>The site, its text, design and code are owned by the Institute or used under license. You may read, print and share pages for personal, noncommercial use.</p>
<p>Work you create remains yours. You grant the Institute a limited license to assess, archive and report on it, and to use de-identified examples for quality improvement. We will not publish your work without your permission.</p>`,
      },
      {
        id: "disclaimer",
        heading: "Disclaimer",
        body: `<p>The site is provided "as is." We work to keep it accurate and available, but we do not warrant that it will be uninterrupted or error-free, or that every page is current. Program information on the site does not replace your offer letter or the student handbook.</p>`,
      },
      {
        id: "liability",
        heading: "Limitation of liability",
        body: `<p>To the extent the law allows, the Institute is not liable for indirect, incidental or consequential losses arising from your use of the site. Nothing in these terms limits rights that cannot be waived under applicable law, including rights you may have as a consumer or student.</p>`,
      },
      {
        id: "law",
        heading: "Governing law",
        body: `<p>These terms are governed by the laws applicable to the Institute's registered jurisdiction. Disputes will be handled in the courts of that jurisdiction, unless the law gives you the right to bring a claim where you live.</p>
<p>Before filing a claim, write to the registrar so we can try to resolve it informally.</p>`,
      },
      {
        id: "changes",
        heading: "Changes to these terms",
        body: `<p>We may update these terms. The effective date at the top of the page changes when we do. Continued use after a change means you accept the updated terms. Material changes will be announced on the portal.</p>`,
      },
      {
        id: "contact",
        heading: "Contact",
        body: `<p><strong>Registrar</strong><br><a href="mailto:registrar@${domain}">registrar@${domain}</a></p>
<p><strong>Privacy office</strong><br><a href="mailto:privacy@${domain}">privacy@${domain}</a></p>
<p>For how we handle personal data, see the <a href="/privacy">privacy notice</a>.</p>`,
      },
    ],
  });
}

export function accessibility(ctx: UiContext): string {
  const domain = esc(ctx.mailDomain);
  return legalDocument(ctx, {
    title: "Accessibility",
    eyebrow: "Accessibility",
    lede: "What we have built, what we know still falls short, and how to get help or report a barrier.",
    description: "AthenIQ Institute's accessibility commitment, known limitations and feedback process.",
    facts: [
      { label: "Target", value: "WCAG 2.2 Level AA" },
      { label: "Last reviewed", value: "November 2026" },
      { label: "Next review", value: "May 2027" },
      { label: "Contact", value: `accessibility@${ctx.mailDomain}` },
    ],
    contactEmail: `accessibility@${ctx.mailDomain}`,
    contactLabel: "Report a barrier",
    asideTitle: "Tell us what blocks you.",
    asideBody:
      "You do not need to diagnose the problem. A page address and a sentence about what happened is enough for us to start.",
    sections: [
      {
        id: "commitment",
        heading: "Our commitment",
        body: `<p>AthenIQ Institute wants the public site, the student portal and the registrar to be usable by everyone, including people who use screen readers, magnification, speech input, or a keyboard instead of a mouse.</p>
<p>Accessibility is part of the product, not a separate project. We check new pages against the standard below before they ship.</p>`,
      },
      {
        id: "standard",
        heading: "The standard we test against",
        body: `<p>We aim to meet <strong>WCAG 2.2 Level AA</strong>. That means, among other things: text contrast of at least 4.5:1, keyboard access to every control, visible focus, labels tied to inputs, and status messages that do not rely on color alone.</p>`,
      },
      {
        id: "implemented",
        heading: "What we have implemented",
        body: `<ul>
<li>Semantic landmarks, headings, lists and tables, and a skip link on every page.</li>
<li>Keyboard-operable navigation, forms and buttons, with a visible focus ring.</li>
<li>Form labels and error messages associated with their inputs.</li>
<li>Status shown with text as well as color.</li>
<li>Motion is limited to a short scroll reveal, which is disabled when the visitor prefers reduced motion; there is no autoplay or sound.</li>
<li>The site works without JavaScript; the two enhancements are optional.</li>
<li>Layout reflows at 320 CSS pixels, and text can be enlarged to 200% without loss of content.</li>
<li>Wide tables scroll inside a region that receives keyboard focus when it overflows.</li>
</ul>`,
      },
      {
        id: "limitations",
        heading: "Known limitations",
        body: `<ul>
<li>On very narrow screens, course and roster tables scroll horizontally. The content is reachable with touch, a trackpad or a focused scroll region, but it is not the most comfortable reading experience.</li>
<li>The AI classroom, the management console and the learning system are separate applications. They are not covered by this statement and have their own accessibility work.</li>
<li>Some third-party documents, such as invoices or signed PDFs, may not be tagged for screen readers. Contact the registrar for an alternative format.</li>
<li>We have not yet completed an external accessibility audit. We will publish the results when we do.</li>
</ul>`,
      },
      {
        id: "feedback",
        heading: "Report a barrier or request an accommodation",
        body: `<p>If something blocks you, tell us. Include the page address, what you were trying to do, and the browser or assistive technology you used.</p>
<p>Email <a href="mailto:accessibility@${domain}">accessibility@${domain}</a>. We acknowledge reports within two business days and aim to give you a plan within ten. If you need an accommodation for admissions, study or an assessment, contact <a href="mailto:registrar@${domain}">registrar@${domain}</a> as well.</p>`,
      },
      {
        id: "assessment",
        heading: "How we assess the site",
        body: `<p>We review this statement and the site twice a year. The last internal review was November 2026; the next is scheduled for May 2027. We test the public site, the portal and the registrar with keyboard-only navigation, a screen reader, 200% zoom and a 320-pixel viewport.</p>`,
      },
      {
        id: "contact",
        heading: "Contact",
        body: `<p><strong>Accessibility</strong><br><a href="mailto:accessibility@${domain}">accessibility@${domain}</a></p>
<p><strong>Registrar</strong><br><a href="mailto:registrar@${domain}">registrar@${domain}</a></p>`,
      },
    ],
  });
}
