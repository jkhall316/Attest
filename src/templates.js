// Summary presets. Pure data — adding a style is a line here, never a code change.
// The 14 original keys are load-bearing: existing D1 rows store them as recordings.template.
// style = what the summary must CONTAIN. group = dropdown section.

export const TEMPLATES = {
  /* ---------- work ---------- */
  meeting:        { label: 'Meeting', group: 'work', style: 'decisions made, who owns what, open questions, next steps' },
  standup:        { label: 'Standup', group: 'work', style: 'per person: done, doing, blocked', length: 'under 120 words' },
  brainstorm:     { label: 'Brainstorm', group: 'work', style: 'every distinct idea, credited, then the clusters they form' },
  retro:          { label: 'Retro', group: 'work', style: 'what worked, what did not, concrete process changes with owners' },
  support_call:   { label: 'Support call', group: 'work', style: 'issue, root cause, resolution given, follow-up needed' },
  kickoff:        { label: 'Project kickoff', group: 'work', style: 'goal, scope boundaries, roles, milestones, first commitments' },
  planning:       { label: 'Planning session', group: 'work', style: 'options considered, tradeoffs raised, what was chosen and why' },
  sprint_planning:{ label: 'Sprint planning', group: 'work', style: 'committed items per person, estimates, dependencies, carryover' },
  design_review:  { label: 'Design review', group: 'work', style: 'what was presented, objections with reasons, agreed changes, open questions' },
  code_review:    { label: 'Code review', group: 'work', style: 'issues found by severity, suggested fixes, what was agreed to change' },
  postmortem:     { label: 'Postmortem', group: 'work', style: 'timeline, root cause, contributing factors, prevention items with owners. No blame' },
  incident_review:{ label: 'Incident review', group: 'work', style: 'customer impact, detection and response timeline, fixes shipped, follow-ups' },
  exec_staff:     { label: 'Exec staff', group: 'work', style: 'decisions, dissent and who raised it, numbers cited, owners and dates' },
  board_update:   { label: 'Board update', group: 'work', style: 'metrics reported, risks named, asks made, follow-ups owed to whom' },
  all_hands:      { label: 'All-hands', group: 'work', style: 'announcements, rationale, questions asked by staff, unanswered questions' },
  hiring_debrief: { label: 'Hiring debrief', group: 'work', style: 'each interviewer\'s verdict with evidence, disagreements, decision and next step' },
  performance_review: { label: 'Performance review', group: 'work', style: 'evidence per expectation, agreed development areas, commitments made by both sides' },
  vendor_call:    { label: 'Vendor call', group: 'work', style: 'what they offered, pricing discussed, concerns, next step and owner' },
  negotiation:    { label: 'Negotiation', group: 'work', style: 'positions, concessions made by each side, what remains open, next move' },
  client_onboarding: { label: 'Client onboarding', group: 'work', style: 'what the client needs, access or setup owed, contacts named, first milestone' },
  handover:       { label: 'Handover', group: 'work', style: 'current state, open threads, where everything lives, who to ask' },
  training_session: { label: 'Training session', group: 'work', style: 'what was taught, questions asked, materials referenced, follow-up practice' },
  workshop:       { label: 'Workshop', group: 'work', style: 'exercises run, outputs produced, group decisions, what carries forward' },
  offsite:        { label: 'Offsite', group: 'work', style: 'themes discussed, agreements reached, owners, what was deliberately left open' },
  qbr:            { label: 'QBR', group: 'work', style: 'results against targets, reasons for variance, commitments for next quarter' },
  project_status: { label: 'Status update', group: 'work', style: 'what is on track, what slipped and why, decisions needed now', length: 'under 150 words' },

  /* ---------- sales ---------- */
  sales_call:  { label: 'Sales call', group: 'sales', style: 'buyer needs, objections, budget/timeline signals, agreed next step' },
  demo:        { label: 'Product demo', group: 'sales', style: 'features shown, reactions and hesitations, questions asked, next step' },
  pricing_call:{ label: 'Pricing call', group: 'sales', style: 'price quoted, pushback, alternatives discussed, where it landed' },
  renewal:     { label: 'Renewal', group: 'sales', style: 'contract terms, expansion or churn signals, blockers, who signs and when' },
  churn_analysis: { label: 'Churn conversation', group: 'sales', style: 'stated reason, real reason if visible, what was tried, what would win them back' },
  objection_log:  { label: 'Objection log', group: 'sales', style: 'each objection verbatim, what was answered, whether it was resolved' },
  cold_call:   { label: 'Cold call', group: 'sales', style: 'who answered, hook used, interest level, next step or reason to stop' },
  pipeline_review: { label: 'Pipeline review', group: 'sales', style: 'deals discussed, current stage, risk, next action with owner and date' },
  partner_call:{ label: 'Partner call', group: 'sales', style: 'what each side brings, commercial terms, dependencies, next milestone' },
  rfp_response:{ label: 'RFP / procurement', group: 'sales', style: 'requirements raised, gaps, compliance questions, deadlines and owners' },
  contract_review: { label: 'Contract review', group: 'sales', style: 'clauses disputed, redlines requested, who approves. Never give legal advice' },

  /* ---------- research ---------- */
  discovery:       { label: 'Customer discovery', group: 'research', style: 'problems in the customer\'s own words, current workarounds, willingness to pay' },
  user_interview:  { label: 'User interview', group: 'research', style: 'tasks described, friction quoted verbatim, tools used, unmet needs' },
  usability_test:  { label: 'Usability test', group: 'research', style: 'task attempted, where they got stuck, quotes, severity of each issue' },
  survey_analysis: { label: 'Survey analysis', group: 'research', style: 'response themes, counts where stated, surprising answers, open questions' },
  focus_group:     { label: 'Focus group', group: 'research', style: 'themes, points of disagreement, notable quotes with who said them' },
  competitive_intel: { label: 'Competitive intel', group: 'research', style: 'claims made about competitors, evidence given, gaps in what we know' },
  paper_discussion:{ label: 'Paper discussion', group: 'research', style: 'claim, method, evidence quality, limitations, what we would reuse' },
  field_notes:     { label: 'Field notes', group: 'research', style: 'observations, exact quotes, context, patterns repeated across sites' },
  lab_meeting:     { label: 'Lab meeting', group: 'research', style: 'results presented, critique raised, experimental next steps with owners' },
  thesis_supervision: { label: 'Thesis supervision', group: 'research', style: 'progress since last time, critiques, agreed next experiments, deadlines' },

  /* ---------- people ---------- */
  one_on_one:      { label: '1:1', group: 'people', style: 'what the person said, what they need, how to support them', length: '120-250 words' },
  interview:       { label: 'Job interview', group: 'people', style: 'candidate signal per question, strengths, concerns, evidence quotes' },
  coaching_session:{ label: 'Coaching session', group: 'people', style: 'what the person wants to change, insights they reached, commitments made' },
  mentoring:       { label: 'Mentoring', group: 'people', style: 'questions asked, advice given and why, agreed next steps' },
  conflict_mediation: { label: 'Conflict mediation', group: 'people', style: 'each side\'s account in their own words, points of agreement, agreed process. No verdicts' },
  family_conversation: { label: 'Family conversation', group: 'people', style: 'what each person said they need, decisions, unresolved feelings, follow-ups' },
  exit_interview:  { label: 'Exit interview', group: 'people', style: 'reasons given, what they would change, what they valued, no retaliation framing' },
  peer_feedback:   { label: 'Peer feedback', group: 'people', style: 'specific examples given, what to keep doing, what to change, agreed follow-up' },
  networking_call: { label: 'Networking call', group: 'people', style: 'who they are, overlap with your work, what was offered, what you owe them' },

  /* ---------- health ---------- */
  medical_visit:   { label: 'Medical visit', group: 'health', style: 'symptoms reported, what the clinician said, medications, follow-up. Never add medical advice' },
  dentist_visit:   { label: 'Dental visit', group: 'health', style: 'findings reported, treatment done or planned, aftercare instructions as stated. Never add medical advice' },
  therapy_intake:  { label: 'Therapy intake', group: 'health', style: 'what was disclosed, goals named, logistics agreed. Never interpret or advise' },
  vet_visit:       { label: 'Vet visit', group: 'health', style: 'symptoms described, diagnosis given, treatment and dosing as stated, recheck date. Never add veterinary advice' },
  pharmacy_consult: { label: 'Pharmacy consult', group: 'health', style: 'medications discussed, dosing and timing as stated, warnings mentioned, questions to ask the prescriber. Never add medical advice' },
  physical_therapy: { label: 'Physical therapy', group: 'health', style: 'assessment, exercises prescribed with reps as stated, restrictions, next session. Never add medical advice' },

  /* ---------- personal ---------- */
  journal:        { label: 'Journal', group: 'personal', style: 'themes, mood, recurring concerns, one thing to act on' },
  voice_memo:     { label: 'Voice memo', group: 'personal', style: 'the idea in one sentence, then supporting detail', length: 'under 100 words' },
  diary_night:    { label: 'End of day', group: 'personal', style: 'what happened, what is still open, what to carry into tomorrow', length: 'under 150 words' },
  dream_log:      { label: 'Dream log', group: 'personal', style: 'what happened in the dream, feelings, recurring symbols, waking life it connects to. No interpretation as fact' },
  gratitude_log:  { label: 'Gratitude log', group: 'personal', style: 'the specific things named and who or what they involve', length: 'under 80 words' },
  goal_review:    { label: 'Goal review', group: 'personal', style: 'each goal\'s state, evidence of progress, what is blocking, next action' },
  errand_memo:    { label: 'Errand / shopping', group: 'personal', style: 'items to get or do, quantities and constraints, where and when', length: 'under 80 words' },
  idea_capture:   { label: 'Idea capture', group: 'personal', style: 'the idea, why it might matter, the smallest next test', length: 'under 120 words' },
  prayer_reflection: { label: 'Reflection', group: 'personal', style: 'what was reflected on, what was asked for, what to hold on to', length: 'under 120 words' },
  travel_log:     { label: 'Travel log', group: 'personal', style: 'where and when, what was seen, people met, practical notes for next time' },

  /* ---------- media ---------- */
  podcast:        { label: 'Podcast / long form', group: 'media', style: 'chapters with timestamps, key claims, notable quotes' },
  webinar:        { label: 'Webinar', group: 'media', style: 'promised agenda, main claims with timestamps, audience questions, CTA made' },
  youtube_video:  { label: 'Video notes', group: 'media', style: 'thesis, key points in order, claims worth checking, timestamps' },
  audiobook_notes:{ label: 'Audiobook notes', group: 'media', style: 'core argument, chapter-level takeaways, quotes worth keeping' },
  film_discussion:{ label: 'Film / TV discussion', group: 'media', style: 'what each person thought, points of disagreement, moments cited' },
  panel_discussion: { label: 'Panel discussion', group: 'media', style: 'each panelist\'s position, where they disagreed, audience questions' },
  conference_talk: { label: 'Conference talk', group: 'media', style: 'thesis, evidence presented, counterarguments addressed, what to follow up on' },
  press_interview: { label: 'Press interview', group: 'media', style: 'questions asked, answers given, quotes that could run, topics to avoid next time' },

  /* ---------- education ---------- */
  lecture:        { label: 'Lecture / study', group: 'education', style: 'core concepts, definitions, worked examples, likely exam questions' },
  class_notes:    { label: 'Class notes', group: 'education', style: 'topics covered, definitions, examples, assigned work' },
  study_group:    { label: 'Study group', group: 'education', style: 'questions each person brought, answers reached, what nobody understood' },
  tutoring_session:{ label: 'Tutoring', group: 'education', style: 'what was attempted, where the student struggled, method that worked, homework' },
  language_practice: { label: 'Language practice', group: 'education', style: 'vocabulary used, corrections given, phrases to drill, mistakes repeated' },
  exam_prep:      { label: 'Exam prep', group: 'education', style: 'topics covered, confidence per topic, weak spots, practice plan' },
  lab_demo:       { label: 'Lab demo', group: 'education', style: 'procedure demonstrated, safety points, results observed, what to write up' },
  reading_group:  { label: 'Reading group', group: 'education', style: 'what was read, interpretations offered, disagreements, next reading' },
};
