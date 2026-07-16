import {
  auditSequence,
  buildSequenceSteps,
  canonicalRoleName,
  chooseCatalogMatch,
  draftSequenceSections,
  rankedCatalogMatches,
  selectOutreachAccounts,
  sequenceSettings,
} from "./provisioning.mjs";

const text = (value) => String(value ?? "").trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function verifyListed(loader, id, name) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const rows = await loader();
    const found = rows.find((row) => row.id === id && row.name === name);
    if (found) return found;
    await sleep(250 * (attempt + 1));
  }
  throw new Error(`Paraform did not list ${name} after creation`);
}

function byId(items, id, label) {
  const item = items.find((row) => row.id === id);
  if (!item) throw new Error(`${label} is missing or not editable`);
  return item;
}

async function chooseSequence(items, role, getCampaign) {
  const ranked = rankedCatalogMatches(items, role);
  if (!ranked.length) return null;
  const exact = ranked.filter((match) => match.score >= 80);
  if (exact.length) {
    const top = exact.filter((match) => match.score === exact[0].score);
    if (top.length > 1) throw new Error(`multiple Paraform Sequences match ${canonicalRoleName(role)}`);
    return top[0];
  }
  // Generic legacy names such as "Outreach for {Title}" or title-only can
  // collide. Reuse one only when its first-email body names this company.
  const inspected = [];
  for (const match of ranked) {
    const campaign = await getCampaign(match.item.id);
    const intro = text([...(campaign?.steps || [])].sort((a, b) => a.step_number - b.step_number)[0]?.body).toLowerCase();
    if (intro.includes(text(role.company).toLowerCase())) inspected.push({ ...match, campaign });
  }
  if (!inspected.length) return null;
  const best = inspected.filter((match) => match.score === inspected[0].score);
  if (best.length > 1) throw new Error(`multiple legacy Paraform Sequences mention ${role.company}; choose one explicitly`);
  return best[0];
}

export async function provisionRoleAssets({
  roleId,
  workspace,
  requestedProjectId = null,
  requestedSequenceId = null,
  now = new Date(),
  adapters,
} = {}) {
  const role = workspace?.rubric?.role || {};
  const context = workspace?.sequenceContext || {};
  const targetName = canonicalRoleName(role);
  const projects = await adapters.listProjects();
  let project;
  let projectCreated = false;
  let projectMatch = null;

  if (requestedProjectId) {
    project = byId(projects, requestedProjectId, "review Project");
    projectMatch = "explicit";
  } else {
    const match = chooseCatalogMatch(projects, role);
    if (match) {
      project = match.item;
      projectMatch = match.kind;
    } else {
      project = await adapters.createProject(targetName);
      await verifyListed(adapters.listProjects, project.id, targetName);
      project = { ...project, name: targetName };
      projectCreated = true;
      projectMatch = "created";
    }
  }

  const sequences = await adapters.listSequences();
  let sequence;
  let sequenceCreated = false;
  let sequenceMatch = null;
  let campaign = null;
  let expectedSteps = null;
  let sequenceDraft = null;

  if (requestedSequenceId) {
    sequence = byId(sequences, requestedSequenceId, "Sequence");
    sequenceMatch = "explicit";
  } else {
    const match = await chooseSequence(sequences, role, adapters.getCampaign);
    if (match) {
      sequence = match.item;
      campaign = match.campaign || null;
      sequenceMatch = match.kind;
    }
  }

  const accounts = selectOutreachAccounts(await adapters.listGmailAccounts());
  if (!sequence) {
    sequenceDraft = await (adapters.draftSections || draftSequenceSections)(context);
    const built = buildSequenceSteps(context, sequenceDraft);
    expectedSteps = built.steps;
    const shell = await adapters.createSequenceShell({ name: targetName, roleId, projectId: project.id });
    sequence = { id: shell.id, name: targetName, enabled: false };
    sequenceCreated = true;
    sequenceMatch = "created";
    try {
      await adapters.updateSequenceSettings(shell.id, sequenceSettings({ name: targetName, accountIds: accounts.map((account) => account.id), now }));
      await adapters.updateSequenceSteps(shell.id, built.steps);
      campaign = await adapters.getCampaign(shell.id);
      await verifyListed(adapters.listSequences, shell.id, targetName);
    } catch (error) {
      await adapters.deleteSequence(shell.id).catch(() => {});
      throw error;
    }
  } else if (!campaign) {
    campaign = await adapters.getCampaign(sequence.id);
  }

  const audit = auditSequence(campaign, {
    name: targetName,
    projectId: project.id,
    company: role.company,
    expectedEmails: accounts.map((account) => account.email),
    expectedSteps,
    startDate: sequenceCreated ? now : null,
  });
  if (audit.dangers.length) {
    if (sequenceCreated) await adapters.deleteSequence(sequence.id).catch(() => {});
    throw new Error(`Sequence safety readback failed: ${audit.dangers.join("; ")}`);
  }
  if (sequenceCreated && audit.warnings.length) {
    await adapters.deleteSequence(sequence.id).catch(() => {});
    throw new Error(`new Sequence failed playbook readback: ${audit.warnings.join("; ")}`);
  }

  return {
    targetName,
    project: { id: project.id, name: project.name },
    sequence: { id: sequence.id, name: sequence.name, enabled: Boolean(campaign?.enabled) },
    projectCreated,
    sequenceCreated,
    projectMatch,
    sequenceMatch,
    sequenceWarnings: audit.warnings,
    sequenceAudit: { accountCount: audit.accountCount, campaignStarted: Boolean(campaign?.enabled), primaryInboxExcluded: !audit.emails.includes("david@raydar.xyz") },
    sequenceDraft: sequenceCreated ? { source: expectedSteps?.length ? "generated" : null, model: sequenceDraft?.model || null } : null,
  };
}
