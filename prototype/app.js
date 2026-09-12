/*
 * Course Companion — shared course-records store and agent logic.
 *
 * Both student.html and faculty.html load this file and read/write the same
 * localStorage-backed record so the two role pages behave as if they were
 * backed by the same course database. Live transcription is real (see
 * server.js + the recording controls in faculty.html, which stream microphone
 * audio to the Gemini Live API); retrieval, grading and study-material
 * generation below are small deterministic heuristics standing in for the
 * rest of the tool-calling agent (search_course_sources / evaluate_submission /
 * create_study_plan / draft_assessment / draft_discussion_topics).
 */

const DB_KEY = "courseCompanionDB_v3";

function uid(prefix) {
  return prefix + "_" + Math.random().toString(36).slice(2, 9);
}

function nowTs() {
  return Date.now();
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function fmtTime(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtDate(dateStr) {
  if (!dateStr) return "—";
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function lectureLabel(l) {
  return `${fmtDate(l.date)} — ${l.title}`;
}

// Example content shown as a faded "placeholder" preview before the real thing
// exists yet (an empty transcript, an unanswered Q&A, an ungraded submission…),
// so every panel demonstrates what it will look like instead of reading blank.
const EXAMPLE_LECTURE_TITLE = "Newton's Laws — Net Force";
const EXAMPLE_TRANSCRIPT_SEGMENTS = [
  { offset: "0s", text: "Today we're looking at Newton's laws and net force." },
  { offset: "8s", text: "Remember, at constant velocity the acceleration is zero." },
  { offset: "16s", text: "So by Newton's Second Law, F net equals m a, the net force is also zero." },
  { offset: "24s", text: "That doesn't mean no forces are acting — it means the forces acting on the object balance out." },
];
const EXAMPLE_QA = {
  question: "How can it keep moving with zero net force?",
  answer: "It can keep moving because constant velocity means zero acceleration, not zero velocity — the forces acting on it still balance out.",
};

// ---------------------------------------------------------------------------
// Seed data — one course, one lecturer, two fictional students, fictional slides
// and past exams (Physics I-61D, Newton's Laws).
// ---------------------------------------------------------------------------
function seedDB() {
  return {
    course: {
      id: "phys-i-61d",
      code: "PHYS-I-61D",
      title: "Physics I",
      unit: "Newton's Laws: net force, acceleration, and constant velocity",
      instructor: "Dr. Armagan Elibol",
    },
    students: [
      { id: "s1", name: "Sara Al Mansoori" },
      { id: "s2", name: "Yousef Al Nuaimi" },
    ],
    currentStudentId: "s1",

    slides: [
      { id: "slide1", page: 1, title: "Slide 1 — Forces & motion overview", concept: null,
        text: "A force is a push or a pull that can change an object's motion. This week we look at how several forces combine." },
      { id: "slide2", page: 2, title: "Slide 2 — Newton's First Law (inertia)", concept: "net-force",
        text: "An object continues at constant velocity — including staying at rest — unless acted on by a net external force." },
      { id: "slide3", page: 3, title: "Slide 3 — Net force & Newton's Second Law", concept: "net-force",
        text: "Net force is the vector sum of every force on an object: F_net = m·a. Constant velocity means acceleration a = 0, so F_net = 0 — even though individual forces may still be acting, as long as they balance." },
      { id: "slide4", page: 4, title: "Slide 4 — Velocity vs. acceleration", concept: "velocity-acceleration",
        text: "Velocity describes how fast and in what direction an object moves. Acceleration describes how velocity changes over time. Constant velocity implies zero acceleration — it does not imply zero velocity, and it does not require a nonzero net force." },
      { id: "slide5", page: 5, title: "Slide 5 — Worked example: car at constant velocity", concept: "net-force",
        text: "A car cruises at a constant 100 km/h on a straight highway. Engine thrust balances air resistance and rolling friction, so the net force is zero even though several individual (nonzero) forces act on the car." },
    ],

    pastExams: [
      { id: "exam1", title: "Midterm 2024 — Forces", released: true,
        questions: ["A book rests on a table. Explain why the net force on the book is zero.", "State Newton's Second Law and give its units."] },
      { id: "exam2", title: "Quiz 3 2024 — Newton's Laws", released: false,
        questions: ["A skydiver falls at terminal velocity. What is the net force acting on them? Explain your reasoning."] },
    ],

    // Lectures are organized by date, not by a "current slide". Each entry is
    // one capture session; db.currentLectureId points at the active/most
    // recent one for Q&A retrieval.
    lectures: [],
    currentLectureId: null,

    qa: [],

    practiceActivity: {
      id: "practice1",
      title: "Constant Velocity — Short Answer",
      prompt: "An object moves at constant velocity. What is its net force? Explain.",
      rubricVersion: 1,
      feedbackVisible: true,
      rubric: [
        { id: "c1", text: "Identifies zero acceleration", max: 1 },
        { id: "c2", text: "Applies Newton's Second Law (F = m·a)", max: 1 },
        { id: "c3", text: "Concludes the net force is zero", max: 1 },
        { id: "c4", text: "Explains individual forces may still act, as long as they balance", max: 1 },
      ],
    },

    submissions: [],
    conceptObservations: [],
    studyPlans: {},
    studyTasks: {},

    assessment: { id: "assess1", status: "none", blueprint: null, questions: [], validation: null },

    discussion: {
      status: "none", // none | draft | published
      publishedLevels: [],
      topics: { broad: [], recommended: [], narrow: [] },
    },

    // Mock gradebook overview (class-level stats per assessment) + each
    // fictional student's own score, for the "Grades" pages.
    gradebook: [
      { id: "gb1", name: "Quiz 1", avgAI: 74, p10: 52, p90: 93, manualReview: 2 },
      { id: "gb2", name: "Quiz 2", avgAI: 68, p10: 45, p90: 88, manualReview: 4 },
      { id: "gb3", name: "Midterm", avgAI: 71, p10: 48, p90: 95, manualReview: 5 },
      { id: "gb4", name: "Assignment 1", avgAI: 82, p10: 60, p90: 97, manualReview: 1 },
    ],
    studentGrades: {
      s1: { gb1: 80, gb2: 72, gb3: 65, gb4: 88 },
      s2: { gb1: 58, gb2: 91, gb3: 74, gb4: 79 },
    },

    ambiguousOutage: false,
  };
}

function loadDB() {
  const raw = localStorage.getItem(DB_KEY);
  if (!raw) {
    const db = seedDB();
    saveDB(db);
    return db;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    const db = seedDB();
    saveDB(db);
    return db;
  }
}

function saveDB(db) {
  localStorage.setItem(DB_KEY, JSON.stringify(db));
}

function resetDB() {
  const db = seedDB();
  saveDB(db);
  return db;
}

// ---------------------------------------------------------------------------
// Lecture capture, organized by date
// ---------------------------------------------------------------------------
function getCurrentLecture(db) {
  return db.lectures.find((l) => l.id === db.currentLectureId) || null;
}

function startLecture(db, title) {
  const lecture = {
    id: uid("lec"),
    date: todayStr(),
    title: (title && title.trim()) || db.course.unit,
    status: "live",
    segments: [],
    seq: 0,
    lastUpdate: nowTs(),
  };
  db.lectures.push(lecture);
  db.currentLectureId = lecture.id;
  saveDB(db);
  return lecture;
}

function addUtterance(db, text) {
  const lecture = getCurrentLecture(db);
  if (!lecture || lecture.status !== "live" || !text.trim()) return null;
  const seg = {
    id: "seg" + lecture.seq,
    seq: lecture.seq,
    text: text.trim(),
    offset: lecture.seq * 8 + "s",
    ts: nowTs(),
  };
  lecture.segments.push(seg);
  lecture.seq += 1;
  lecture.lastUpdate = nowTs();
  saveDB(db);
  return seg;
}

function stopLecture(db) {
  const lecture = getCurrentLecture(db);
  if (!lecture) return null;
  lecture.status = "archived";
  lecture.lastUpdate = nowTs();
  saveDB(db);
  return lecture;
}

// ---------------------------------------------------------------------------
// Retrieval + private Q&A
// ---------------------------------------------------------------------------
const CONCEPT_KEYWORDS = {
  "net-force": ["net force", "constant velocity", "zero net force", "newton's second law", "f=ma", "second law", "balance"],
  "velocity-acceleration": ["acceleration", "velocity", "speed up", "slow down", "changing velocity"],
};

function findSlidesByKeywords(db, text) {
  const lower = text.toLowerCase();
  const hits = [];
  for (const slide of db.slides) {
    for (const [concept, kws] of Object.entries(CONCEPT_KEYWORDS)) {
      if (slide.concept === concept && kws.some((k) => lower.includes(k))) {
        hits.push(slide);
        break;
      }
    }
  }
  return hits;
}

function allSegments(db) {
  return db.lectures.flatMap((l) => l.segments.map((s) => ({ ...s, lectureId: l.id, lectureDate: l.date })));
}

function findTranscriptHits(db, text) {
  const lower = text.toLowerCase();
  const words = lower.split(/\W+/).filter((w) => w.length > 3);
  return allSegments(db).filter((seg) => {
    const segLower = seg.text.toLowerCase();
    return words.some((w) => segLower.includes(w));
  });
}

function askQuestion(db, studentId, question) {
  const slideHits = findSlidesByKeywords(db, question);
  const transcriptHits = findTranscriptHits(db, question);
  const sources = [];
  transcriptHits.slice(-2).forEach((seg) => {
    const lec = db.lectures.find((l) => l.id === seg.lectureId);
    sources.push({ kind: "transcript", id: seg.id, label: `${lec ? lectureLabel(lec) : "Transcript"} @ ${seg.offset}` });
  });
  slideHits.slice(0, 2).forEach((sl) => sources.push({ kind: "slide", id: sl.id, label: sl.title }));

  let answer, status;
  if (sources.length === 0) {
    status = "insufficient_evidence";
    answer =
      "I can't support an answer to this from the finalized lecture transcript or the released slides yet. " +
      "Try asking about net force, constant velocity, or the difference between velocity and acceleration — " +
      "or wait for the instructor to cover this point.";
  } else {
    status = "supported";
    const combinedText = [...transcriptHits, ...slideHits].map((s) => s.text).join(" ");
    if (combinedText.toLowerCase().includes("velocity") && combinedText.toLowerCase().includes("acceleration") &&
        question.toLowerCase().includes("keep moving")) {
      answer =
        "It can keep moving because constant velocity means zero acceleration, not zero velocity. " +
        "By Newton's Second Law (F_net = m·a), zero acceleration means the net force is zero — the forces " +
        "acting on it (like engine thrust and air resistance) are still there, they just balance out.";
    } else if (combinedText.toLowerCase().includes("net force")) {
      answer =
        "At constant velocity the acceleration is zero, so by F_net = m·a the net force is zero. " +
        "That doesn't mean no forces are acting — it means the individual forces balance.";
    } else {
      answer =
        "Velocity is how fast and in what direction something moves; acceleration is how quickly that velocity " +
        "changes. An object can move (nonzero velocity) while accelerating at zero — that's the constant-velocity case.";
    }
  }

  const entry = {
    id: uid("qa"),
    studentId,
    lectureId: db.currentLectureId,
    question,
    answer,
    sources,
    status,
    ts: nowTs(),
  };
  db.qa.push(entry);
  saveDB(db);
  return entry;
}

// ---------------------------------------------------------------------------
// Feedback + study loop
// ---------------------------------------------------------------------------
function evaluateSubmission(answerText) {
  const lower = answerText.toLowerCase();
  const checks = {
    c1: /zero acceleration|acceleration (is|=) ?0|no acceleration/i.test(lower),
    c2: /f\s*=\s*m\s*a|newton'?s second law|f_?net\s*=\s*m/i.test(lower),
    c3: /net force.*(zero|0)|zero net force|net force is 0/i.test(lower),
    c4: /balance|balanced|cancel|equal and opposite|still act|individual forces/i.test(lower),
  };
  const scores = { c1: checks.c1 ? 1 : 0, c2: checks.c2 ? 1 : 0, c3: checks.c3 ? 1 : 0, c4: checks.c4 ? 1 : 0 };
  const total = scores.c1 + scores.c2 + scores.c3 + scores.c4;
  const confusesVelocityAccel =
    /nonzero net force|non-zero net force|net force is not zero|must be moving.*force/i.test(lower) ||
    (!checks.c1 && !checks.c3);

  const feedback = {
    c1: checks.c1 ? "Good — you correctly identified that acceleration is zero." : "Missing: state explicitly that acceleration is zero at constant velocity.",
    c2: checks.c2 ? "Good — you connected this to Newton's Second Law (F = m·a)." : "Missing: connect the result to Newton's Second Law, F_net = m·a.",
    c3: checks.c3 ? "Good — you concluded the net force is zero." : "Missing/incorrect: constant velocity implies the net force is zero.",
    c4: checks.c4 ? "Good — you noted individual forces can still act as long as they balance." : "Missing: mention that individual (nonzero) forces may still be acting, as long as they balance.",
  };

  const concepts = [];
  if (confusesVelocityAccel) concepts.push({ id: "velocity-acceleration", label: "Velocity vs. acceleration" });

  return {
    scores, total, max: 4, feedback, concepts,
    sourceRefs: [
      { kind: "slide", id: "slide3", label: "Slide 3 — Net force & Newton's Second Law" },
      { kind: "slide", id: "slide4", label: "Slide 4 — Velocity vs. acceleration" },
    ],
  };
}

function saveFeedback(db, studentId, activityId, answerText) {
  const priorSameVersion = db.submissions.find((s) => s.studentId === studentId && s.activityId === activityId && s.answer === answerText);
  if (priorSameVersion) return priorSameVersion;

  const version = db.submissions.filter((s) => s.studentId === studentId && s.activityId === activityId).length + 1;
  const evalResult = evaluateSubmission(answerText);
  const submission = {
    id: uid("sub"), studentId, activityId, answer: answerText, version,
    rubricVersion: db.practiceActivity.rubricVersion, ts: nowTs(),
    provisional: evalResult, reviewed: null,
  };
  db.submissions.push(submission);

  evalResult.concepts.forEach((c) => {
    const priorCount = db.conceptObservations.filter((o) => o.studentId === studentId && o.conceptId === c.id).length;
    db.conceptObservations.push({
      id: uid("obs"), studentId, conceptId: c.id, label: c.label,
      evidenceState: priorCount >= 1 ? "recurring-gap" : "needs-practice-provisional",
      submissionId: submission.id, ts: nowTs(),
    });
  });

  saveDB(db);
  return submission;
}

function createStudyPlan(db, studentId, conceptId) {
  if (!db.studyPlans[studentId]) db.studyPlans[studentId] = [];
  const existing = db.studyPlans[studentId].find((p) => p.conceptId === conceptId);
  if (existing) return existing;

  const templates = {
    "velocity-acceleration": {
      conceptLabel: "Velocity vs. acceleration",
      why: "Your last submission described a nonzero net force at constant velocity, which suggests velocity and acceleration are being conflated.",
      explanation: "Velocity is how fast and in what direction something moves. Acceleration is how quickly velocity changes. Constant velocity means acceleration is exactly zero — the object can still be moving fast.",
      sourceRef: { kind: "slide", id: "slide4", label: "Slide 4 — Velocity vs. acceleration" },
      workedExample: "A car cruising at a constant 100 km/h has zero acceleration. By F_net = m·a, the net force is zero, even though the engine and air resistance are both still pushing on the car.",
      questions: [
        "A cyclist rides at a constant 20 km/h on a flat road. What is their acceleration? What is the net force?",
        "An elevator moves upward at a constant speed. Is there a nonzero net force on it? Explain using Newton's Second Law.",
      ],
    },
  };
  const t = templates[conceptId];
  if (!t) return null;

  const plan = { id: uid("plan"), studentId, conceptId, conceptLabel: t.conceptLabel, why: t.why, explanation: t.explanation,
    sourceRef: t.sourceRef, workedExample: t.workedExample, questions: t.questions, ts: nowTs() };
  db.studyPlans[studentId].push(plan);
  saveDB(db);
  return plan;
}

// ---------------------------------------------------------------------------
// Ambiguous AI study-task workflow
// ---------------------------------------------------------------------------
function acceptStudyTask(db, studentId, plan, dueDate) {
  if (!db.studyTasks[studentId]) db.studyTasks[studentId] = [];
  const already = db.studyTasks[studentId].find((t) => t.planId === plan.id && t.syncState !== "declined");
  if (already) return already;

  const task = {
    id: uid("task"), planId: plan.id,
    title: `Review ${plan.sourceRef.label.split("—")[0].trim()} and complete two practice questions`,
    sourceRefs: [plan.sourceRef], dueDate: dueDate || null, createdAt: nowTs(),
    providerId: null, syncState: "pending",
  };

  if (db.ambiguousOutage) {
    task.syncState = "pending";
  } else {
    task.providerId = "amb_" + Math.random().toString(36).slice(2, 10);
    task.syncState = "synced";
  }

  db.studyTasks[studentId].push(task);
  saveDB(db);
  return task;
}

function retrySyncTask(db, studentId, taskId) {
  const task = (db.studyTasks[studentId] || []).find((t) => t.id === taskId);
  if (!task || task.syncState === "synced") return task;
  if (db.ambiguousOutage) return task;
  task.providerId = "amb_" + Math.random().toString(36).slice(2, 10);
  task.syncState = "synced";
  saveDB(db);
  return task;
}

function declineStudyTask() {
  return null;
}

function readStudyTasks(db, studentId) {
  return db.studyTasks[studentId] || [];
}

// ---------------------------------------------------------------------------
// Faculty: assessment drafting
// ---------------------------------------------------------------------------
function assessmentQuestionPool(db) {
  return [
    { type: "mcq",
      prompt: "A car moves at a constant velocity along a straight road. What is the net force acting on it?",
      options: ["Equal to m·a in the direction of motion", "Zero", "Equal to the car's weight", "Undefined without more information"],
      correctIndex: 1, marks: 2, conceptIds: ["net-force"],
      sourceRefs: [{ kind: "slide", id: "slide3", label: "Slide 3 — Net force & Newton's Second Law" }] },
    { type: "mcq",
      prompt: "Which quantity describes how quickly velocity is changing over time?",
      options: ["Velocity", "Displacement", "Acceleration", "Force"],
      correctIndex: 2, marks: 2, conceptIds: ["velocity-acceleration"],
      sourceRefs: [{ kind: "slide", id: "slide4", label: "Slide 4 — Velocity vs. acceleration" }] },
    { type: "short",
      prompt: "An object moves at constant velocity. What is its net force? Explain.",
      expectedAnswer: "Acceleration is zero at constant velocity; by F_net = m·a the net force is zero, though individual forces may still act as long as they balance.",
      rubric: db.practiceActivity.rubric, marks: 4, conceptIds: ["net-force", "velocity-acceleration"],
      sourceRefs: [
        { kind: "slide", id: "slide5", label: "Slide 5 — Worked example: car at constant velocity" },
        { kind: "exam", id: "exam1", label: "Midterm 2024 — Forces" },
      ] },
    { type: "mcq",
      prompt: "An object is at rest and stays at rest. What does Newton's First Law say about the net force on it?",
      options: ["It must be zero", "It must equal the object's weight", "It must be increasing", "It cannot be determined"],
      correctIndex: 0, marks: 2, conceptIds: ["net-force"],
      sourceRefs: [{ kind: "slide", id: "slide2", label: "Slide 2 — Newton's First Law (inertia)" }] },
    { type: "mcq",
      prompt: "In the constant-velocity car example, why is the net force zero even though the engine is producing thrust?",
      options: ["Air resistance and friction balance the thrust", "The car has no mass", "Gravity cancels the thrust", "The road is frictionless"],
      correctIndex: 0, marks: 2, conceptIds: ["net-force"],
      sourceRefs: [{ kind: "slide", id: "slide5", label: "Slide 5 — Worked example: car at constant velocity" }] },
  ];
}

function draftAssessment(db, blueprint) {
  const pool = assessmentQuestionPool(db);
  const count = Math.max(1, Math.min(20, Number(blueprint.numQuestions) || pool.length));
  const questions = [];
  for (let i = 0; i < count; i++) {
    const base = pool[i % pool.length];
    const repeatSuffix = i >= pool.length ? ` (variant ${Math.floor(i / pool.length) + 1})` : "";
    questions.push({ ...base, id: "q" + (i + 1), prompt: base.prompt + repeatSuffix });
  }

  db.assessment.blueprint = blueprint;
  db.assessment.questions = questions;
  db.assessment.status = "draft";
  db.assessment.validation = validateAssessment(db, questions, blueprint);
  saveDB(db);
  return db.assessment;
}

function validateAssessment(db, questions, blueprint) {
  const totalMarks = questions.reduce((sum, q) => sum + Number(q.marks || 0), 0);
  const targetMarks = blueprint && blueprint.totalMarks ? Number(blueprint.totalMarks) : totalMarks;
  const requiredConcepts = ["net-force", "velocity-acceleration"];
  const coveredConcepts = new Set(questions.flatMap((q) => q.conceptIds));
  const missingConcepts = requiredConcepts.filter((c) => !coveredConcepts.has(c));
  const answerIssues = questions.filter(
    (q) => (q.type === "mcq" && (q.correctIndex === undefined || !q.options?.length)) || (q.type === "short" && !q.expectedAnswer)
  );
  const similarityFlags = [];
  for (const exam of db.pastExams) {
    for (const eq of exam.questions) {
      for (const q of questions) {
        if (q.prompt && eq && q.prompt.toLowerCase().includes("net force") && eq.toLowerCase().includes("net force")) {
          similarityFlags.push({ questionId: q.id, examId: exam.id, note: `Similar phrasing to "${eq}"` });
        }
      }
    }
  }
  return {
    totalMarks, marksMatch: totalMarks === targetMarks, missingConcepts,
    answerIssues: answerIssues.map((q) => q.id), similarityFlags,
    ok: totalMarks === targetMarks && missingConcepts.length === 0 && answerIssues.length === 0,
  };
}

function updateAssessmentQuestion(db, questionId, patch) {
  const q = db.assessment.questions.find((q) => q.id === questionId);
  if (!q) return db.assessment;
  Object.assign(q, patch);
  db.assessment.validation = validateAssessment(db, db.assessment.questions, db.assessment.blueprint);
  saveDB(db);
  return db.assessment;
}

function publishAssessment(db) {
  db.assessment.status = "published";
  saveDB(db);
  return db.assessment;
}

// ---------------------------------------------------------------------------
// Faculty: discussion preparation topics — Broad topics vs. Narrow topics
// (narrow = drawn directly from what will actually appear on the assessment).
// ---------------------------------------------------------------------------
const DISCUSSION_TEMPLATES = {
  broad: [
    "Newton's laws, net force, and motion.",
    "The relationship between force, mass, and acceleration.",
  ],
  recommended: [
    "Explain why constant velocity implies zero net force.",
    "Distinguish between velocity and acceleration using a worked example.",
  ],
  narrow: [
    "You will be asked to identify the net force on an object moving at constant velocity (it's zero, from F_net = m·a with a = 0).",
    "You will be asked to explain, in writing, why individual forces can still act on an object at constant velocity as long as they balance.",
  ],
};

function draftDiscussionTopics(db, specificity) {
  db.discussion.status = "draft";
  db.discussion.topics[specificity] = [...DISCUSSION_TEMPLATES[specificity]];
  saveDB(db);
  return db.discussion;
}

function updateDiscussionTopics(db, specificity, topics) {
  db.discussion.topics[specificity] = topics;
  saveDB(db);
  return db.discussion;
}

function publishDiscussionTopics(db, specificity) {
  if (!db.discussion.topics[specificity] || db.discussion.topics[specificity].length === 0) return db.discussion;
  if (!db.discussion.publishedLevels.includes(specificity)) db.discussion.publishedLevels.push(specificity);
  db.discussion.status = "published";
  saveDB(db);
  return db.discussion;
}

// ---------------------------------------------------------------------------
// Faculty: grading review
// ---------------------------------------------------------------------------
function reviewSubmission(db, submissionId, action, editedScores) {
  const sub = db.submissions.find((s) => s.id === submissionId);
  if (!sub) return null;
  if (action === "reject") {
    sub.reviewed = { action: "rejected", reviewer: db.course.instructor, ts: nowTs() };
  } else {
    const scores = action === "edit" && editedScores ? editedScores : sub.provisional.scores;
    const total = Object.values(scores).reduce((a, b) => a + Number(b), 0);
    sub.reviewed = { action, scores, total, max: sub.provisional.max, reviewer: db.course.instructor, ts: nowTs() };
  }
  saveDB(db);
  return sub.reviewed;
}

function setFeedbackVisibility(db, visible) {
  db.practiceActivity.feedbackVisible = visible;
  saveDB(db);
}

function toggleAmbiguousOutage(db, on) {
  db.ambiguousOutage = on;
  saveDB(db);
}

function setCurrentStudent(db, studentId) {
  db.currentStudentId = studentId;
  saveDB(db);
}

function studentName(db, studentId) {
  const s = db.students.find((s) => s.id === studentId);
  return s ? s.name : studentId;
}

function getSourceById(db, kind, id) {
  if (kind === "slide") return db.slides.find((s) => s.id === id);
  if (kind === "exam") return db.pastExams.find((e) => e.id === id);
  if (kind === "transcript") {
    for (const seg of allSegments(db)) if (seg.id === id) return { title: `Transcript segment @ ${seg.offset}`, text: seg.text };
    return null;
  }
  if (kind === "lecture") {
    const l = db.lectures.find((l) => l.id === id);
    if (!l) return null;
    return { title: lectureLabel(l), text: l.segments.map((s) => s.text).join(" ") || "(no finalized transcript yet)" };
  }
  return null;
}
