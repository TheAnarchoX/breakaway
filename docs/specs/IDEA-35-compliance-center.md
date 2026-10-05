# IDEA-35 · Compliance Center: controls, SBOMs, risks, data, and processors on the board

Task: IDEA-35 on the board · Status: approved (shaped 5 Oct 2026, merged by the owner, and BRK-160 is decided). Not built yet: its tasks are open.

## Problem
Someone building a product alone, or with agents, has to show it is built safely as well as build it: that changes are reviewed and checked, that dependencies are known and their licences allowed, that security alerts get fixed, which personal data the product holds and why, which vendors process it and whether a data processing agreement (DPA) is signed, and which risks they accept. Today that lives in spreadsheets, a vendor's dashboard, or nowhere, and it goes stale the day it's written. The board already sees most of the evidence (pull requests, checks on `main`, Dependabot alerts, the deploy pipeline, releases), but it shows none of it as compliance.

The Compliance Center turns that into one view per repository: controls the board checks by itself, a software bill of materials (SBOM) for every release, a risk register with a matrix, a data inventory, and a register of processors and their DPAs, with a report to hand an auditor or a customer's questionnaire. A failing control becomes a task an agent can fix, so staying compliant is ordinary work on the board.

## Fit
- **Free, and self-hosted.** It's part of every install: no paid tier, no hosted service, no certification sold.
- **An install keeps its data.** Everything is read from GitHub, which the owner already connected, and kept in the install's Durable Object. No scanner service, vulnerability feed, or licence database is called: the SBOM is GitHub's dependency graph, alerts are GitHub's, and a check the board can't do itself is a workflow in the repository's own CI that the board reads the result of.
- **The person who runs the board decides.** The registers (risks, data inventory, processors) change only from the signed-in board. Agents read a repository's compliance state and may propose entries; only the owner accepts them. A failing control makes a task only on the owner's press, or by itself only when the owner turned that on, as with new security alerts.
- **Taskwarrior stays first-class.** Nothing changes in the task model: a task made from a control is an ordinary task that names the control, and mitigations are ordinary tasks a risk links by work ID.
- **One board, several repositories.** Every control result, SBOM, risk, inventory entry, and processor belongs to one repository. A processor used by several repositories is entered in each (a later version may share them).
- **It isn't Architect.** IDEA-19 (the board runs the infrastructure) owns live cloud state, inventories of real resources, and policies at apply time. This feature checks only what the repository declares and what GitHub reports, so it doesn't wait on IDEA-19 and doesn't pre-empt its decisions.

## Design

### 1. Controls: automated compliance checks
A control is one rule with a result (passing, failing, or unknown), the evidence the board saw, when it last checked, and how to fix it. The board evaluates every control on each GitHub sync it already runs (webhooks, and the 5-minute cron), so results stay current with no new schedule. Built-in controls, each on by default and switchable per repository:

| Group | Control | Passes when | Reads |
| --- | --- | --- | --- |
| Change | Reviewed changes | The default branch's rules require a pull request | Rulesets (metadata), or classic branch protection (Administration, optional) |
| Change | Checked changes | The default branch's rules require at least one status check | the same |
| Change | Main is green | The latest run of every workflow on the default branch passed | Already synced |
| Dependencies | No open alerts at or above a severity | No open Dependabot alert at or above the chosen severity (default: high) older than the chosen days (default: 7) | Already synced |
| Dependencies | Allowed licences | Every package in the SBOM has a licence on the repository's allow list (default: none set, so the control is off until there is one) | The SBOM (section 2) |
| Dependencies | SBOM available | The dependency graph returns an SBOM for the default branch | The SBOM |
| Code | No open code scanning alerts at or above a severity | as above | Code scanning alerts (optional, read) |
| Code | No open secret scanning alerts | No open secret scanning alert | Secret scanning alerts (optional, read) |
| Pipeline | Workflows use least privilege | Every workflow file sets `permissions:` at the top or on every job | Workflow files (Contents, already granted) |
| Pipeline | Actions pinned | Every third-party `uses:` is pinned to a commit SHA | Workflow files |
| Pipeline | Deploys can roll back | With a deploy pipeline, it has Roll back (IDEA-27) | The pipeline |
| Repository | Security policy | `SECURITY.md` (or `.github/SECURITY.md`) exists | Contents |
| Repository | Licence | A licence file exists | Contents |
| Data | Processors have DPAs | Every processor that receives data has a signed DPA, or doesn't need one | The registers (section 5) |

**Custom controls** are how a repository tests anything else, infrastructure included: a named check run or workflow in its own CI (a policy-as-code scan of its infrastructure files, a migrations check, an accessibility run). The control passes when that check's latest run on the default branch passed. breakaway never runs the tool: the repository's CI does, and the board reads the result, as it already does for checks.

**Where it's configured.** `.github/breakaway-compliance.json` in the repository, reviewed like code, read from the default branch (as `.github/breakaway-pipeline.json` is): controls switched off, severity and day thresholds, the licence allow list, and custom controls. Without the file, the built-in defaults apply. A file the board can't parse leaves the last good one in force and shows on Connections, like a broken pipeline file.

**History is the evidence.** The board keeps each control's changes of result (not every evaluation), with the commit and time, for 400 days, so "was this passing on 1 March?" has an answer. An optional permission that is missing makes its controls *unknown*, with the fix (the permission to grant), never *failing*.

**A failing control becomes work.** **Fix with an agent** on a failing control makes a task (the repository's area for such work, `+agent +compliance`, the control, evidence, and fix in its description, linked to the control) and starts an agent, the way a Dependabot alert does today. A setting, **New failing controls**, makes that task by itself (off by default; it never starts an agent unless the task's own start-by-itself rules allow). When the control passes again, the task says so in a comment; the pull request still closes it.

### 2. SBOM
The SBOM is GitHub's dependency graph export (`GET /repos/{owner}/{repo}/dependency-graph/sbom`, SPDX 2.3 JSON), which the App's Contents permission already reads. The board fetches it at most once a day and when the default branch moves (throttled to one fetch an hour), keeps the latest, and keeps one per stable release, fetched when the release is published, so each release has the SBOM it shipped with. The view shows the package count, direct versus all, the licences found (with packages missing one), and downloads the SPDX file. The repository's dependency graph has to be on (it is for public repositories; a private one shows how to turn it on, as an *unknown* control).

### 3. Risks
A risk register per repository: title, what could happen, likelihood and impact (1 to 5 each), the score, a treatment (reduce, accept, transfer, avoid), status (open, reducing, accepted, closed), the tasks that reduce it (work IDs, any area), and a review date. The view shows a 5 × 5 matrix, each cell counting its risks, with a list beside it, highest score first. A failing control can **Add as a risk**, prefilled. When a risk's review date passes, it shows in the inbox (a note, no push).

### 4. Data inventory
What personal data the repository's product handles, as categories, never records: the kind of data (email addresses, payment details, …), whose (customers, staff, …), a special-category flag, the purpose, the legal basis (GDPR's six, or "not applicable"), where it's stored (a system named in words), how long it's kept, and the processors that receive it (section 5). **Draft with an agent** starts a general agent with a prompt the board writes: read the repository's code and propose entries, citing the files. The agent proposes through the CLI; proposals show as drafts the owner accepts, edits, or drops. The agent reads code, never the product's data.

### 5. Processors and DPAs
The vendors that process the product's data: name, service, region, the inventory entries they receive, DPA status (not needed, needed, requested, signed), signed on, review by, and a link to where the owner keeps the agreement. A processor with data and no signed DPA is a failing control (**Processors have DPAs**), so it can become a task (for the owner: `+owner`). A review date that passes shows in the inbox. The board keeps the record, not the document (decision 2).

### 6. The report
**Export** on the view (and `npx breakaway compliance report`) writes one Markdown file and one JSON file for a repository at a moment: every control with its result, evidence, and history over a chosen period, the SBOM summary and the file's name, the risks, the data inventory laid out as a record of processing activities (GDPR Article 30's headings), and the processors, and can group the controls by SOC 2 or ISO 27001 (decision 4). It's made on the install and downloaded; it goes nowhere else.

### 7. Where it lives on the board
- **Compliance** in the sidebar opens `#/compliance` for the repository the switcher shows (with one repository, that one). Tabs: Controls (the default: failing first, then unknown, then passing), SBOM, Risks, Data, Processors. Under All repositories it lists each repository's failing and unknown counts, linking to each.
- The GitHub view's security alerts link to the Controls tab; Connections shows the compliance file's state and the optional permissions.
- **Empty and first-run states.** A repository without the GitHub App: the view says compliance needs it and links to Connections. A fresh repository: built-in controls with their results, and empty registers that each say what to add first and why (Risks: "Add the risk that keeps you up at night."; Data: **Draft with an agent**). Nothing to fix: "Every control passes." with when it last checked. Offline: the last results, marked with their time.

### 8. API and CLI
- `GET /api/compliance?repo=<slug>` (controls, SBOM summary, registers), `GET /api/compliance/sbom?repo=<slug>[&release=<tag>]`, and `GET /api/compliance/report?repo=<slug>&from=<date>`. Readable with the board's token, so agents see what they need to fix a control.
- `POST /api/compliance/proposals?repo=<slug>`: an agent proposes risks or inventory entries; they're drafts until accepted.
- Changing a register, accepting a proposal, and the settings are cookie only, like Promote, so an agent's token never reaches them.
- `npx breakaway compliance [status|sbom|report|propose]`: the state of the checkout's repository, the SBOM file, the report, and proposals from a JSON file.

## Privacy
- The registers hold categories, purposes, vendors, and dates: never personal data, never a person's name or contact, and never the agreement itself. The forms say so beside the fields.
- Everything stays in the install's Durable Object and is read only from GitHub. The report is a download.
- An agent session sees control results, the SBOM, and the registers of its own repository through the token, and proposes; it never accepts. The Draft with an agent prompt tells it to read code, never data, and never to put real records in a proposal.
- In a public repository, `.github/breakaway-compliance.json` is public: it holds settings, never a register.

## Out of scope
- Live cloud infrastructure: resources, drift, and policies at apply time are Architect's (IDEA-19). Infrastructure is checked here only through the repository's own CI, as custom controls.
- Running scanners, or calling any vulnerability, licence, or compliance service.
- Certification, auditor workflows, questionnaires answered for you, and frameworks beyond GDPR, SOC 2, and ISO 27001.
- Storing signed documents (decision 2), and processors shared across repositories.
- Personal data requests (access, deletion) for the product's users.

## Decisions
The owner answered these on BRK-160 (5 Oct 2026):

1. **The registers live on the board**, in the install's Durable Object, private to the install. A public repository never publishes its risks or vendors.
2. **The board keeps a link to each DPA**, never the document.
3. **Infrastructure in this version is what the repository declares**, checked by its own CI as custom controls. Reading a cloud account waits for Architect (IDEA-19).
4. **Frameworks: GDPR's record of processing, SOC 2, and ISO 27001.** Each control and register names the SOC 2 Trust Services Criteria and ISO 27001:2022 Annex A controls it gives evidence for (IDs and short titles only, never the standards' text), custom controls name theirs in the compliance file, and the view and the report group results by either framework and list the criteria the board has no evidence for. It's evidence for an audit, not a certification.
5. **The GitHub App asks for code scanning and secret scanning alerts (read).** New installs get them; an existing one sees GitHub's request, and its owner accepts it (BRK-168).

## Done when
- A repository's Compliance view shows the built-in controls with real results from GitHub, and a custom control from its `.github/breakaway-compliance.json` follows that check on `main`.
- A failing control can become a task, by press or by the setting, and its history answers what it was on a past date.
- The SBOM downloads for the default branch and for each stable release since the feature shipped, with its licences.
- The owner can keep risks (with the matrix), the data inventory (with an agent's draft accepted), and processors with their DPA status, and review dates reach the inbox.
- The report downloads as Markdown and JSON, and the controls group by SOC 2 and ISO 27001.
- The manual describes it, and the brand's claims still hold.

The tasks, all in the `compliance-center` feature, all waiting for IDEA-35:

| Task | What | Waits for |
| --- | --- | --- |
| BRK-160 | The owner's decision (answered) | IDEA-35 |
| BRK-161 | Controls, the compliance file, history, and the new permissions | BRK-160 |
| BRK-162 | SBOMs | BRK-161 |
| BRK-163 | The registers, proposals, and review dates | BRK-160 |
| BRK-164 | Fix with an agent on a control, and New failing controls | BRK-161 |
| WEB-58 | The Compliance view: Controls and SBOM | BRK-161, BRK-162 |
| WEB-59 | Risks, Data, and Processors tabs | BRK-163, WEB-58 |
| BRK-166 | Draft the data inventory with an agent | BRK-163 |
| BRK-167 | The report | BRK-162, BRK-163 |
| BRK-165 | SOC 2 and ISO 27001 mapping | BRK-161, BRK-163, BRK-167, WEB-58 |
| CLI-11 | `npx breakaway compliance` | BRK-162, BRK-167 |
| BRK-168 | The owner accepts the App's new permissions (`+owner`) | BRK-161 |
| DOC-28 | The manual, README, site docs, and the decision log | WEB-59, BRK-164, BRK-165, BRK-166, CLI-11 |

## How to check it
1. Update and deploy your board as usual once the tasks are merged, and accept the App's new permissions on GitHub if the board asks.
2. Open the board and choose **Compliance** in the sidebar. You should see controls for the repository, such as "Reviewed changes" and "Main is green", each passing or failing with the evidence and when it was checked.
3. Pick a failing control and press **Fix with an agent**. A task should appear with the control and how to fix it, and an agent should start on it.
4. Open the **SBOM** tab and download it. You should get a file listing the repository's packages and their licences.
5. On **Risks**, add a risk with likelihood 4 and impact 5. It should appear in the top right of the matrix.
6. On **Data**, press **Draft with an agent**. When it finishes, you should see proposed entries citing files in the code; accept one.
7. On **Processors**, add a vendor that receives that data with DPA status "needed". The control "Processors have DPAs" should fail until you set it to signed.
8. Press **Export**. You should get a report with all of the above in one document.
9. Group the controls by **ISO 27001**, then by **SOC 2**. Each control should show the references it gives evidence for, with the ones the board can't evidence listed apart.
