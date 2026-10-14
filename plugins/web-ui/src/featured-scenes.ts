import { activeTips, type HomeTip, type WebuiHomeConfig } from "./home-config.ts";

export const FEATURED_SCENES = [
  {
    id: "W01",
    category: "presentation",
    title: "Turn complex materials into a strong presentation",
    outcome: "Find the storyline in messy materials and finish a professional, editable PPT with charts and narrative.",
    inputs: "Source documents, data tables, images and brand rules; the audience, length and goal of the talk.",
    output: "An editable PPTX, speaker notes for each slide, and a list of sources for materials and data.",
    prompt:
      "Please turn the materials I provide into an illustrated PPT fit for a formal presentation. First work out the audience, the key decisions and the speaking time; if information is missing, list the key questions once. Extract one clear storyline, shape it into a story of about 15–20 slides, decide the conclusion, evidence and visual treatment of each slide, then build the complete editable PPTX.\nTurn real data into charts and business relationships into clear diagrams; where needed add images with a clear source or usage right, and keep fonts, colors, grid and image treatment consistent. Do not give every slide the same title plus three bullets, and do not pass off a full-page screenshot as an editable slide. Each slide carries one main point, and complex slides must still read from a distance.\nDeliver the PPTX, speaker notes for each slide, and a list of data and image sources. Check the definitions and sources of the numbers, render the whole deck to check overflow, overlap, fonts and images; mark missing evidence as to be supplied, and do not invent data.",
    image: new URL("./assets/scenarios/complex-030/presentation.webp", import.meta.url).href,
  },
  {
    id: "W11",
    category: "tender",
    title: "Combine every department's materials into one good bid",
    outcome:
      "Break down the tender requirements, coordinate commercial, technical and delivery materials, and check every response end to end.",
    inputs:
      "Tender documents, addenda, scoring rules, qualifications library, technical proposal, pricing basis, department contacts and deadlines.",
    output:
      "A response matrix, a task list per department, technical and service proposals, a list of gaps and conflicts, and a merged DOCX.",
    prompt:
      "Please help organize a joint bid across several departments. Working from the tender documents I upload and the latest addenda, first build a clause response matrix: clause location, mandatory requirement, scoring point, evidence needed, responsible department, deadline and current status. Separate commercial, technical, delivery and after-sales materials, and identify dependencies and the critical path.\nFirst give the division of work and the document outline; once I provide each department's materials, merge the proposal into an editable bid document that is logically unified and consistent in its figures. For repeated wording, contradictions, version conflicts and missing proof, state the source and a suggested fix item by item. The technical proposal must explain the architecture, implementation steps, milestones, risks, acceptance metrics and service guarantees, without piling up vague promises.\nDeliver the XLSX response matrix and task list, the complete merged DOCX, a list of items to confirm and a pre-submission checklist. Every qualification, case, person, price and commitment must be backed by material; leave a clear placeholder for anything missing. When a version changes, say which chapters and departments are affected; before sending tasks or messages to members, follow the confirmed division of work and authorization.",
    image: new URL("./assets/scenarios/complex-030/tender.webp", import.meta.url).href,
  },
  {
    id: "W25",
    category: "design",
    title: "From a business need to a design you can try",
    outcome:
      "Clarify roles and flows, design the key screens and error states, and make the proposal ready for review.",
    inputs: "Business goals, user roles, flow and interview notes, existing screens, brand and platform constraints.",
    output:
      "A core flow diagram, a list of pages and states, interaction designs, a clickable HTML prototype and a short PRD.",
    prompt:
      "Please produce a reviewable product design proposal from the business materials provided. First make clear the user roles, core tasks, success metrics and constraints, and turn the pain points of the current business flow into prioritized requirements; list the assumptions that have no evidence yet.\nFor the most important paths, design the information architecture, page flow and key interactions, covering the normal, loading, empty, failed, no-permission and duplicate-submission states. Settle the interface style and component rules first, then complete consistent designs and a clickable HTML prototype; also consider desktop and narrow screens, keyboard use, text contrast and readability.\nDeliver the flow diagram, the list of page states, the designs, the prototype entry point and a short PRD, explaining how each key design decision solves a business problem. Use synthetic data, clearly mark the actions the prototype only simulates, and do not present prototype behavior as a connection to a real system. Finally walk every key path and record the states not covered and the assumptions still to verify.",
    image: new URL("./assets/scenarios/complex-030/product.webp", import.meta.url).href,
  },
  {
    id: "W05",
    category: "collaboration",
    title: "Make project progress traceable to materials",
    outcome:
      "Keep collecting meetings, weekly reports and deliverables, and track milestones, blockers and materials still owed.",
    inputs:
      "The project plan, milestones, roles, meeting minutes, weekly reports, deliverables and their update history.",
    output:
      "A progress ledger, an index of materials, a list of blockers and risks, to-dos per owner, and a weekly or management summary.",
    prompt:
      "Please act as the project's collaboration assistant and maintain progress from the project plan and the materials added over time. First map milestones, deliverables, owners, deadlines and acceptance conditions to each other, and organize a catalog of project materials recording file version, source, owner and gaps.\nFor each new batch of meeting minutes, weekly reports, proposals and deliverables, identify new tasks, changed commitments, dependency conflicts, signs of delay and missing evidence, update the ledger and keep a note of what changed. Keep “planned as done”, “owner reports done”, “materials prove done” and “formally accepted” apart; a file existing is not enough to mark something done.\nDeliver an editable XLSX progress ledger, an index of materials, current blockers and risks, to-dos grouped by owner, and a one-page management summary. Link every judgement to its evidence; mark items without a clear owner or date as to be confirmed. When regular tracking is needed, first make clear the data sources you can reach, the update frequency and who is notified, then follow the confirmed arrangement; do not assume you can read systems that are not shared yet or run unattended for long.",
    image: new URL("./assets/scenarios/complex-030/progress.webp", import.meta.url).href,
  },
  {
    id: "W09",
    category: "data",
    title: "From business data to improvement actions",
    outcome:
      "Align the departments' report definitions, find the causes of variance, and turn the review into actions with owners.",
    inputs:
      "Budget and actual data, definitions of business metrics, department reports, data for the same period in earlier years and business notes.",
    output:
      "A verifiable analysis XLSX, a table of metric definitions, a list of anomalies and assumptions, a review brief and improvement tasks.",
    prompt:
      "Please carry out a verifiable business review from the departments' reports. First build a metric dictionary, check periods, units, tax basis, scope and duplicates, keep the raw data and record the cleaning rules. Break down variance by budget versus actual, year on year and period on period, and the main business dimensions, stating the calculation method and source cells of every conclusion.\nUse the business materials to explain likely causes, separating facts the data supports directly, assumptions that can be verified, and questions that cannot be attributed yet. For the key problems, form improvement actions, suggested responsible departments, measures and checkpoints; owners and committed dates come from the actual materials or from confirmation.\nDeliver an XLSX with formulas and charts, the table of metric definitions, the list of anomalies, a management review summary and the list of improvement tasks. Check that totals, parts, percentages and units agree; do not write correlation as causation, and do not pass off missing values as zero.",
    image: new URL("./assets/scenarios/complex-030/review.webp", import.meta.url).href,
  },
  {
    id: "W13",
    category: "collaboration",
    title: "Complete the chain of evidence before acceptance",
    outcome:
      "Go through the contract and acceptance requirements item by item and get every party to supply the missing test, delivery and training materials.",
    inputs:
      "The contract and technical specification, acceptance criteria, change records, test reports, delivery list, and training and operations materials.",
    output:
      "An acceptance tracking matrix, a list of gaps and conflicts, a catalog of materials, a remediation plan and the acceptance presentation.",
    prompt:
      "Please help the project team prepare a formal acceptance. Taking the contract, the technical specification, confirmed changes and the acceptance criteria as the baseline, build a tracking matrix of “requirement, deliverable, verification method, existing evidence, gap, responsible party”. Organize the test, deployment, training, user manual and operations handover materials, and check versions and coverage.\nIdentify evidence that is missing, out of date, contradictory or only a verbal conclusion; for each gap propose concrete actions to close it, prerequisites and a sensible order, forming a remediation plan that can be carried out. Keep complete materials apart from acceptance passed, and never presume a metric is met when it was not actually verified.\nDeliver the XLSX tracking matrix, an index of materials by category, the list of remediation and items to confirm, the agenda of the acceptance meeting and the presentation. Every coverage conclusion must trace back to a place in an original file; where a signature, a record or an actual test is missing, say so plainly and do not produce invented proof.",
    image: new URL("./assets/scenarios/complex-030/acceptance.webp", import.meta.url).href,
  },
] as const;

export function featuredScenarioTips(config: WebuiHomeConfig): HomeTip[] {
  const active = activeTips(config);
  return FEATURED_SCENES.flatMap((scene) => {
    const tip = active.find((item) => item.id === scene.id);
    return tip ? [{ ...tip, title: scene.title, oneLiner: scene.outcome, prompt: scene.prompt }] : [];
  });
}
