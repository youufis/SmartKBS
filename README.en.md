# SmartKBS — AI-Powered Smart Teaching Platform

> **🌐 [中文](README.md) | [English](README.en.md)**
>
> **An AI-powered smart teaching platform for primary, junior secondary and senior secondary schools** — subjects, grades and classes are all configuration-driven, **with no subject hard-coded anywhere**.
>
> It covers the five tracks **teach · learn · practise · assess · manage**, with one chapter per track across the 48 feature areas and 50+ capabilities:
>
> - 🏠 **Entry · Home and To-Dos** — role-aware dashboard, student to-do list
> - 🧑‍🏫 **Teach · Teaching and Resources** — course syllabus, AI podcast, AI teaching assistant, smart question bank, online exams, paper composing with Word export, AI resource recommendations, AI-generated HTML resources, resource centre and management, file centre
> - 🎓 **Learn · Learning and Practice** — AI knowledge Q&A, AI learning companion, course exercises, targeted practice, wrong-answer review, daily picks and trending news, code practice
> - 🎪 **Practise · Classroom Activities** — class quiz, classroom voting, question management, class drill, class ladder, buzzer rounds, group discussions, collaborative whiteboard, smart roll call and attendance, knowledge quests, assignments (chat / files)
> - 📊 **Assess · Analytics and Motivation** — AI learning analytics, AI class summary, progress and activity monitoring, data export, growth portfolio and the AI portrait, plus 12-level titles, achievement badges and the automatic points engine
> - ⚙️ **Manage · System Management** — users and permissions, announcements, notification centre, AI skill management, system configuration, online incremental upgrade, multi-theme appearance
>
> Built with **FastAPI + React**, integrated with Alibaba Cloud DashScope (Qwen / Wanxiang) and DeepSeek. SSE streaming and WebSocket channels carry classroom concurrency; every byte of data stays in local SQLite files and local directories, so the platform can run fully offline.

![Version](https://img.shields.io/badge/version-9.0.0-blue)
![Backend](https://img.shields.io/badge/backend-FastAPI-green)
![Frontend](https://img.shields.io/badge/frontend-React%2019%20%2B%20TypeScript-blue)
![AI](https://img.shields.io/badge/AI-DashScope%20%7C%20DeepSeek-orange)
![License](https://img.shields.io/badge/license-AGPL--3.0-red)

---

<a id="toc"></a>

## Table of Contents

- 📋 [Project Introduction](#intro) · 💡 [Core Design Philosophy](#philosophy) · 🎮 [Demo Environment](#demo) · ✨ [Feature Overview](#overview)
- 📦 [Changelog](#changelog) · 🚢 [Deployment Guide](#deployment) · 🚀 [Quick Start](#quickstart) · 📁 [Project Structure](#structure)
- 💾 [Data Storage](#storage) · 👥 [Permissions Overview](#permissions) · 🔧 [Tech Stack](#tech-stack) · 📄 [License](#license) · ❓ [FAQ](#faq) · 📬 [About](#about)

**Chapters:** [Home and To-Dos](#ch-home) · [Teaching and Resources](#ch-teach) · [Learning and Practice](#ch-learn) · [Classroom Activities](#ch-practice) · [Analytics and Motivation](#ch-assess) · [System Management](#ch-manage)

---

> 📌 **Highlights of V9.0.0**
>
> **Mistake book and auto consolidation**
> - 📕 **The mistake book is now card-based**: one question reads top to bottom — stem, your answer against the correct one, explanation, knowledge points — with the figure beside the stem and dropping below it on narrow screens
> - 🧠 **Mistakes finally carry explanations**: existing bank explanations show in a collapsible block; missing ones can be AI-generated straight into the bank — **empty slots only, never overwriting a teacher's text**
> - 🔎 **Filter, group, batch, export**: pending / mastered / all with real counts, group by exam, topic or question type, keyword search, topic chips as filters, batch mark-as-mastered, and a Word export with explanations
> - 🔁 **Auto consolidation practice works again**: an unanswered set no longer blocks forever, pushes notify with a direct link, cooldown and a daily cap were added, selection prefers frequently-missed and long-neglected questions while avoiding recent sets, all four knobs live in system settings, and teachers can push a set on demand
> - 🧭 **Admins decide what feeds the mistake book**: tick which activities' mistakes are collected in system settings (exams are always included), and the page shows its current scope; students who only ever did practice or class questioning can now be reached too
> - 🧭 **Teacher-targeted practice is visible again**: sets pushed to named students and auto-consolidation sets used to vanish from the student home page and the to-do list; they are listed now, consolidation sets ranked first, one click straight into the answers
>
> **Resource centre and content types**
> - 🏷️ **Web resources now have a content-type system**: 11 types — courseware, animation, course practice, chapter practice, interactive quiz, lab simulation, podcast, custom page, activity, handout, unclassified
> - ✍️ **The type can be set by hand**: an explicit mark beats filename guessing, artifacts are classified when written, **follow renames and are cleared on delete**; click the tag in any of four places to reclassify, and filter by type at the top
> - 🗃️ **One-click grouping for ungrouped resources**: by content type, chapter or section, with a preview before anything is written; only ungrouped files are touched and same-named groups are reused
> - ✂️ **Two kinds of practice separated**: AI course practice records student scores, generated chapter exercises record nothing — they used to share one label
>
> **Sharing and binding**
> - 🗂️ **Three share tabs, consistent semantics**: a new "My shares" tab (only what you actually shared out, admins included), "Shared with me" renamed "Shared by colleagues", and admin management now addresses shares by record instead of guessing from the path
> - 🔁 **Re-sharing really works and merges**: one physical file shared by several people is one card, with a note about who else shared it
> - 🧩 **Resource binding rebuilt**: one registry replaces six hard-coded lists, synchronous practice is on the shelf, and the picker gained a facet sidebar, card layout and honest totals
>
> **Security, analytics and polish**
> - 🔒 **Path traversal in static file serving fixed** (server files were reachable without logging in); the API listing page is no longer exposed by default in production
> - 📊 **Bank analytics no longer truncate**: full per-creator type and subject breakdowns, click a chip to filter
> - 📥 **Bulk import reports the reason per row**; question management is faster; editing a knowledge point's chapter now shows the chapter name and actually saves
> - 📱 **Detail tables became cards on phones**; portrait and avatar images no longer break with 401
>
> **System settings rebuild**
> - ⚙️ **105 settings regrouped by scenario**: five technical groups became four (School & Branding / Teaching & Incentives / AI Capabilities / Storage & Security), with a new "Answer Quality" section
> - 🧭 **Master-detail layout**: a left tree switches sections, the right pane lists one section at a time; 46 everyday settings are shown, 59 advanced ones fold away
> - 🎛️ **No more typing enum values**: rank visibility, skill injection position and ladder skin became dropdowns; quest question source and portrait period became radio groups; the question-type list became a dialog editor
> - 📝 **Copy corrected**: "5 sections" was really 24, "no restart needed" contradicted the field notes, and stray Markdown asterisks and hard line breaks are gone
> - 🔒 **No more lost edits**: switching sections or searching no longer clears other sections on save, and leaving with unsaved changes is blocked
>
> - ⚠️ **Breaking changes**: none
>
> 🔄 **Upgrading**: desktop — install the new package over the old one (your data stays); source package — replace it once by hand; Git deployment — the in-app incremental upgrade flow is unchanged. This is a formal 8.9.0 → 9.0.0 release; database changes, including the new content-type mark table, are applied automatically at startup.

---

<a id="intro"></a>

## Project Introduction

**SmartKBS** puts lesson preparation, question authoring, classroom activities, practice, exams, learning analytics, honours and operations inside one account system and one data pipeline. A whole school, a single teaching group or one teacher can use it directly instead of stitching several tools together.

The platform is **subject-agnostic**. The subject list, grades, classes, question types, titles, AI models and prompt templates all come from configuration (`backend/system_config.json` plus the database master tables), so switching curricula means changing configuration, not code. SmartKBS itself grew out of a single subject (Artificial Intelligence) and was later generalised — "no hard-coded subject" is an implemented fact, not a marketing line.

Built-in grade master data covers **primary, junior secondary and senior secondary** stages: twelve preset grades from Grade 1 (一年级) to Senior 3 (高三). A teacher account can hold a multi-grade teaching scope such as `高一|高二` (Senior 1 | Senior 2), and every read and write is filtered by that scope. Preschool and higher-education stages have no built-in stage rules; they require extending the grade master data.

AI capabilities go through a single invocation service offering three modes, taken over by priority and degrading step by step:

1. **Retrieval-augmented generation** — once a knowledge base is ready it takes over the whole AI chain: retrieve first (Bailian knowledge base, or the local question bank and syllabus), generate from what was matched, show the cited sources in the UI, and fall back to the next level when retrieval fails
2. **Bailian agent application** — call a pre-configured agent app directly
3. **Direct model invocation** — the fallback path, compatible with DashScope and DeepSeek

> 📦 **Three ways to deploy**: one-click Windows desktop installer (no environment, no Python / Node.js) · source package · Git clone (with online incremental upgrades). See the [Deployment Guide](#deployment).

<a id="philosophy"></a>

## Core Design Philosophy

- **🧠 AI native, but bank first**
  AI lives inside authoring, grading, Q&A, analysis and the whiteboard rather than as a bolted-on chat box. Anything already answerable from stored data never calls the model: generation and composing always go "question bank first → AI covers the gap → the AI question must be stored before it is returned", so every unit of compute turns into a reusable asset.
- **🎯 Teach according to aptitude**
  The student-side companion adapts its tone and recommendations to the persona the student chose (encouraging / rigorous / humorous), the knowledge points they keep missing, and their learning profile. The teacher-side assistant scopes its help to that teacher's classes and subject.
- **🔄 A closed loop, driven by a data flywheel**
  Behaviour collection → AI analysis → personalised feedback → behaviour change. Exams, practice, conversations, roll call and class drills enrich the learner profile, and the profile feeds the next round of AI decisions and recommendations.
- **⚡ On-demand calls, zero idle spend**
  Every AI call is triggered by actual use: the daily pick pool refills only once it is exhausted, news summaries load lazily, a portrait is generated only when someone asks for one (or when the opt-in per-period job is enabled), and speech synthesis bills nothing while switched off. No compute is burned on an empty classroom.

**Product strengths**

| Strength | How it is delivered |
| --- | --- |
| 👥 Three roles, each with its own AI | Students get a companion, teachers get an assistant, admins get global control — without interfering with each other |
| 🏆 Gamified motivation | 12-level titles + achievement badges + an automatic points engine replace external pressure with steady positive feedback |
| 🌐 Configuration-driven, subject-agnostic | Changing subject means editing configuration and prompt templates, never code |
| 🔒 Local-first | Two SQLite databases plus local directories; runs fully offline, AI goes through endpoints reachable from China, pip mirrors available, student data never leaves the school |
| 📱 Zero-install multi-device | Works in a phone browser with no app and no extra deployment |
| 🖥️ One-click desktop edition | Electron shell with bundled backend and frontend, so the target machine needs no Python / Node.js |
| ⬆️ Online incremental upgrade | Git deployments upgrade in place: fetch, migrate, install dependencies, restart — with automatic rollback on failure |

<a id="demo"></a>

## Demo Environment

| Purpose | URL |
| --- | --- |
| Development | [http://youufis.oicp.net:8086](http://youufis.oicp.net:8086) · [https://youufis.oicp.net:8085](https://youufis.oicp.net:8085) |
| Deployment | [http://183.239.51.37:8086](http://183.239.51.37:8086) · [https://183.239.51.37:8085](https://183.239.51.37:8085) |

**Test accounts**

| Role | Username | Password |
| --- | --- | --- |
| Teacher | `youufis` | `ultraultra` |
| Student | `s11001` ~ `s11009` | `123456` |
| Student | `s18001` ~ `s19009` | `123456` |

> ⚠️ **Shared demo environment** — every visitor works on the same database of test data, and your actions are visible to others. Do not enter real student names, real grades or any confidential school material.

<a id="overview"></a>

## Feature Overview

The six chapters map one-to-one onto the tracks listed in the preface (🏠 Entry is the layer that aggregates them all):

| Track | Chapter | Covers | Areas |
| --- | --- | --- | :---: |
| 🏠 Entry | [Home and To-Dos](#ch-home) | Role-aware dashboard, aggregated student to-dos | 2 |
| 🧑‍🏫 Teach | [Teaching and Resources](#ch-teach) | Syllabus, AI podcast, AI teaching assistant, question bank, exams, composing with Word export, AI resources, resource centre and management, file centre | 11 |
| 🎓 Learn | [Learning and Practice](#ch-learn) | AI chat, AI companion, course exercises, targeted practice, wrong-answer review, daily picks and news, code practice | 7 |
| 🎪 Practise | [Classroom Activities](#ch-practice) | Class quiz, voting, questions, class drill, class ladder, buzzer rounds, discussions, whiteboard, attendance and roll call, assignments (chat / files), knowledge quests | 9 |
| 📊 Assess | [Analytics and Motivation](#ch-assess) | Learning analytics, class summary, progress, activity monitoring, view tracking, exports, points, classroom points, hall of glory, growth portfolio, My portrait | 11 |
| ⚙️ Manage | [System Management](#ch-manage) | Users, announcements, configuration, skills, notifications, upgrade, about, other services | 8 |

> The **permission note** at the end of each section states which roles can reach that feature; the full matrix is in the [Permissions Overview](#permissions).

### Mobile access

The platform runs directly in a phone browser - **no app to install**. On a phone the focus is "students practise and check, teachers review and approve"; heavy management pages stay desktop-only.

#### Pages open on mobile

| Role | Count | Pages |
| --- | --- | --- |
| Student | 27 | dashboard, AI companion, wrong questions, daily picks, hot news, notifications, announcements, classroom questions, quick quiz, to-dos, homework, points and titles, exams and results, weekly AI profile, companion settings, knowledge quests, synced practice, classroom interaction, classroom polls, group discussions and rooms, file centre, growth portfolio, showcase, my resources, resource centre, about |
| Teacher / admin | 22 | dashboard, AI assistant, notifications, announcements, question management, AI class summary, learning analytics, assignment grading confirmation, classroom points, weekly AI profile, group discussions and monitor, quest records, summary export, file centre, growth portfolio, showcase, my resources, resource centre, resource management, about |

#### How it behaves on a phone

- A fixed five-slot bottom bar: home / companion (assistant for teachers) / wrong questions (questions for teachers) / notifications / **menu**, which lists everything available for the current role
- Features that are not adapted hide their entry; opening one by URL shows a "use the desktop app" notice with a one-tap way back
- Exam taking, quiz answering and quest battles are standalone full-screen pages with enlarged touch targets and a persistent countdown and progress bar
- Lists (notifications, announcements, exams, quiz records, homework, resources) switch to cards or scroll sideways on narrow screens, so titles never collapse into one character per line

#### Desktop only

Question bank management and paper composing, question maintenance, user management, system configuration, roll call, class drill, class ladder, AI podcast generation, activity monitor, summary export, curriculum maintenance, group discussions, quest administration, code practice, collaborative whiteboard, admin console

<a id="ch-home"></a>

## Home and To-Dos

What you see first after login — the role-aware dashboard and the student to-do list, the entry layer for all five tracks.

### Dashboard (System Home)

After login, the smart dashboard is displayed by default, aggregating key data by role:

**Student Side:**

- 📋 Pending exams count, completed exams count
- 🏆 Cumulative classroom points and class ranking
- ✅ Active tasks count and weekly conversation count
- 📝 Pending class quizzes, participated votes
- 📅 Upcoming exam list (one-click start)
- 📈 Recent exam results (score/pass status)
- 📢 System announcement scrolling display
- ⏱️ Recent activity timeline
- 🚀 Quick access (Q&A/Exam Center/Points/Interaction)

**Teacher/Admin Side:**

- 📊 Exam overview (total/draft/published/ended)
- 📋 Total task submissions and active tasks
- 👥 Total students, total teachers, teaching subjects
- 🎯 Weekly roll call count
- 📝 Total class quizzes and in-progress count
- 📊 Active votes and respondent count
- 💬 Today's conversation count
- 🚀 Quick access (AI Chat/Exam Publishing/Roll Call/User Management/Interaction)

> **Available to all logged-in users**

---

### To-Do Items (Student Task Aggregation)

Student-specific task aggregation board:

- 📊 To-do items grouped by category (Assessments, Course Learning, Interactive Classroom, Shared Resources, System Services)
- 🔴 Upcoming deadline highlights
- 🚀 One-click jump to corresponding feature pages
- 📈 Completion progress statistics

> **Available to students**

---

<a id="ch-teach"></a>

## Teaching and Resources

The teacher's full path from preparation to shared resources: syllabus, authoring, composing, exams, AI-generated and shared content.

### Course Syllabus (Course Guide)

Course → Chapter → Section → Knowledge Point four-level tree structure:

- **🤖 AI Smart Generation**: Paste text or upload files (txt/md/pdf/docx), AI automatically extracts course structure
- **✏️ Manual Management**: Add, edit, delete courses/chapters/knowledge points
- **🔀 Drag-and-Drop Sorting**: Sort within and across levels for flexible organization
- **🔗 Resource Binding**: Bind 7 types of resources to knowledge points (HTML courseware, downloadable files, questions, exams, discussions, class quizzes, tasks)
- **✅ Learning Progress Tracking**: Students learn knowledge points one by one, mark completion status, real-time progress bar
- **📊 Course Progress Overview (Teacher)**: Knowledge point completion progress matrix for all students in a class, filterable by grade/class
- **🏋️ Course Exercises**: Teachers generate 10 multiple-choice questions per knowledge point with one click; students answer online

> **Admin/Teacher can manage; Student can view and mark progress**

---

### Teaching Assistant (Teacher/Admin Exclusive)

AI-powered teaching tool assistant for teachers and administrators:

- **📝 Smart Lesson Planning**: Automatically generates complete lesson plans based on topics (teaching objectives, teaching process, classroom activities, homework design)
- **📄 Auto Exam Generation**: Generates exam papers and class quizzes by knowledge point/question type/difficulty
- **📊 Learning Analytics**: Analyzes class or individual student performance data, identifies weak points and areas for improvement
- **🎯 Activity Planning**: Designs classroom interaction plans (group discussions, quick-answer, class quizzes, etc.)
- **📋 Teaching Data Sidebar**: Real-time display of student count, exam statistics, task submissions, classroom interactions, and other teaching overviews
- **🎨 Visual Differentiation**: Teal-green assistant-style chat bubbles and avatar

> **Available to Teacher/Admin (switch at the top of the Smart Answer page)**

---

### Question Bank Management (Smart Question Bank)

AI-powered smart question management system supporting multiple question types and multimedia:

- **🤖 One-Click AI Generation**: Automatically generate questions by subject, type, knowledge point, difficulty, and quantity
- **📤 Smart Extraction**: Supports pasting text or uploading .docx/JSON files, automatically identifies types, options, and answers
- **🧱 One door into the bank**: AI generation, smart extraction and every practice / quiz backfill share the same entry point — validate, dedup, one transaction, link knowledge points after commit; ungradeable questions are turned away at the door with a reason. One write path per question, so grading, duplicate checks and question selection agree from the source onward, and a future gate only has to be added in one place
- **📋 Supported Types**: Multiple-choice, multi-select, true/false, short answer, fill-in-the-blank, essay, subjective
- **📐 Formula Support**: Full support for LaTeX formula ($...$) rendering display
- **🖼️ Image System**:
  - SVG drawing for technical diagrams
  - Tongyi Wanxiang generates realistic images
  - Supports image generation, preview, deletion, concurrent generation optimization
  - Image placeholder management
- **📂 Question Bank Management**: filtering, search, edit, delete; **multi-select bulk deletion** with the same rules as single delete (others' questions and ones in use are skipped with per-row reasons, 500 per call)
- **📐 Compact list**: fixed table layout with measured column widths — the stem column takes the remaining space, media thumbnails shrink, rows lose about 30% height
- **🔄 AI Image Generation**: Automatically generates images for subjective question SVG/image placeholders

> **Available to Admin and Teacher**

---

### Exam Publishing (Online Exam System)

Complete online exam management system:

- **⚙️ Create Configuration**: Title, subject, duration, total score, passing score, shuffle questions/options, attempt count, time range
- **📋 Paper Composition Methods**:
  - **Smart Selection**: Filter by question type/difficulty/knowledge point, AI-assisted
  - **Manual Selection**: Pick questions one by one from the question bank
- **📋 Exam Flow**: Publish → Students answer online (real-time countdown) → Auto-grading of objective questions → View results
- **📊 Score Statistics**: Score/total score/percentage/pass-fail/ranking
- **📤 Data Export**: Export scores to Excel
- **🔔 Notifications**: Auto-notify on publish/cancel/modify/early termination

> **Admin/Teacher can create and manage; Student can take published exams**

---

### Smart Paper Generation & Word Export

Step-by-step guided paper generation wizard supporting smart selection and professional document export:

- **📋 Configuration Wizard**: Question type and quantity configuration, difficulty distribution, knowledge point range filtering
- **🤖 AI Smart Selection**: Intelligent matching by knowledge point
- **🔌 Gap filling**: off by default so a shortfall is only reported; tick it and AI generates and stores exactly the missing questions
- **📊 Rule-Based Selection**: Random extraction by difficulty proportion
- **📊 Paper Composition Statistics Panel**: Real-time question type/difficulty distribution, total score, supports manual question removal
- **📄 Word Export** (three documents):
  - **Exam Paper**: For students, with answer lines
  - **Answer Key**: Red-annotated answers + blue explanations
  - **Answer Sheet**: Standard answer sheet format
- **📐 LaTeX Formula Rendering**: Rendered as images via matplotlib for embedding
- **🖼️ SVG Auto-Convert to PNG**: Ensures Word compatibility
- **📦 Question Type Ordering**: Multiple-choice → Multi-select → True/False → Fill-in-the-blank → Short answer → Essay → Subjective

> **Available to Admin and Teacher**

---

### AI Teaching Resource Recommendations

Intelligently recommends teaching resources based on knowledge point content:

- **🔍 Smart Analysis**: AI analyzes knowledge point content and automatically recommends related resources
- **📋 Recommendation Types**: HTML courseware, exam papers, classroom discussions, class quizzes, tasks
- **🔗 One-Click Binding**: Recommended resources can be directly bound to knowledge points
- **📄 AI-Generated Courseware**: AI can automatically generate complete HTML courseware based on knowledge points

> **Available to Admin and Teacher**

---

### AI Podcast (Two-Host Dialogue)

One click turns a knowledge point into an HTML podcast page you can actually listen to:

- **🎧 Two-host dialogue**: a host (male voice by default) and a guest (female voice by default); both voices are configurable in System Settings, and when left empty the backend picks one male and one female voice for the current speech model
- **🎚 Pick a duration**: 3 / 4 / 5 minutes, 3 by default; the script length is budgeted per tier (about 250 characters per minute for dialogue)
- **🧠 Two ways to pick a topic**: let AI suggest a batch of topics for the knowledge point (rerollable), or type your own
- **📄 The model writes the script, the backend renders the page**: speech is synthesised per segment, played in order, the transcript highlights the current line, and clicking a line jumps there
- **⏱ Duration is computed, not guessed**: seconds come from the audio byte size, anything past the limit is truncated and labelled on the page
- **🎨 Four themes**: Midnight / Light / Sepia / Ocean — choose one when generating, and readers can switch on the page (top-right)
- **♻️ Saves compute**: identical lines are reused across podcasts (content-addressed cache), and a knowledge point someone else already generated is reused read-only
- **📎 Born as a resource**: the generated page lands in "My Resources"; bind it to a knowledge point and students can open and listen (phone browsers work too)
- **🔒 Shares the master switch with roll-call voice**: turning speech synthesis off in System Settings disables AI Podcast as well (zero billing)

> **Available to Admin and Teacher (the admin must enable speech synthesis first)**

---

### AI-Generated HTML Resources

Use AI directly in the Resource Center to generate HTML teaching resources:

- **📄 5 Resource Types**:
  - 🎬 **Animation Explanation**: 3D parallax, particle animations, etc. to vividly explain knowledge
  - ✍️ **Interactive Quiz**: card-based answering with instant feedback; picking calls the roll-call API, so it shares the weights and shows up in Pick records
  - 📝 **Chapter Exercise**: Structured exercises with question number navigation and submit button
  - 🧪 **Lab Interaction**: Algorithm visualization, math/physics/chemistry experiments, AI interactive simulation
  - 🎨 **Custom HTML**: Freely input topics, generate any HTML as needed
- **🎭 Theme Selection**: Multiple preset themes for each type
  - Animation 17 types, Quiz 20 types, Exercise 10 types, Lab 12 types
- **📚 Question Bank + AI Mixed Questioning**: Automatically matches questions from the question bank, AI supplements; the number of questions can be set before generating shortfalls
- **💾 AI New Questions Auto-Added**: AI-generated questions are automatically saved to the question bank
- **🔗 Subject/Grade Smart Association**: Fetches corresponding question bank based on subject and grade

#### Lab Interaction Resource Details

Covers **9 Subject Categories**:

- 🔬 **Algorithms & Programming**: Sorting/search visualization, data structures, compiler principles
- 📐 **Mathematics**: Function curve parameter tuning, geometric proofs, probability & statistics, calculus
- ⚡ **Physics**: Mechanics simulation, circuit simulation, optical experiments, thermodynamics cycles
- 🧪 **Chemistry**: Molecular structures, chemical reactions, periodic table, titration experiments
- 🧬 **Biology**: Cell structure, DNA replication, ecosystems, genetic hybridization
- 🌍 **Geography & Astronomy**: Map projections, climate simulation, solar system model, plate tectonics
- 🏛️ **Humanities & Society**: Historical timelines, economic models, grammar analysis, color matching experiments
- 🤖 **Artificial Intelligence**: CNN visualization, image classification, Transformer attention mechanism
- 🎯 **General Interaction**: Drag-and-drop clicks, chart linking, custom simulation

**Multi-file subdirectory structure** (for complex resources)

**Image Enhancement**: AI automatically plans and generates SVG educational diagrams + Tongyi Wanxiang realistic images

> **Available to Admin and Teacher**

---

### Resource Center (Sharing Center)

Displays HTML teaching resource files in a card grid:

- **👁️ Card Browsing**: Thumbnail + file name
- **🔗 Sharing Operations**:
  - **Admin Sharing**: Can select "Everyone", "Specific Teacher", "Specific Grade/Class"
  - **Teacher Sharing**: Select "Admin and Teachers" + "Own Classes"
- **🔍 Search & Filter**: Search by file name
- **🗂️ Unified Browser**: students' Shared Resources, teachers' Shared With Me and students' Shared Files share one browsing UI (unseen / time / type / course / sharer / audience facets + grid & list views + remembered preferences)
- **🔗 Direct positioning**: opening a task-list or share notification lands straight on the right tab instead of the default one
- **🤖 AI Generation**: 5 resource types (Animation Explanation, Interactive Quiz, Chapter Exercise, Lab Interaction, Custom HTML)
- **👁️ Resource View Tracking**: Automatically records student viewing behavior

> **Available to all logged-in users; Students can only view shared resources**

---

### Resource Management

Upload/delete/rename teaching resource files:

- 📤 Upload files, directories (HTML/CSS/JS/images/documents, etc.)
- 🗑️ Delete and rename
- 📁 Each teacher has an independent resource directory
- 🔗 File sharing operations (same as Resource Center sharing)
- 📊 Quota management

> **Available to Admin and Teacher**

---

### File Center

Download directory file management:

- 📤 Upload / 📥 Download / 🗑️ Delete
- 📊 Quota management (independent quota per teacher)
- 📁 Subdirectory support
- 🔗 Directory sharing (the whole directory inherits permissions; recipients see it as a folder entry showing how many files it holds and its total size)
- 🗂️ Unified resource browser: shares the category sidebar / stats strip / grid & list views / search, sort, pagination and remembered preferences with Shared Resources
- 👁️ Students can view shared files, with unseen/seen state and view counts tracked (first view awards 1 point)

> **Available to Admin and Teacher; Students can view shared files**

---

<a id="ch-learn"></a>

## Learning and Practice

The student side: knowledge Q&A, the AI companion, syllabus and targeted practice, wrong-answer review, wider reading and hands-on coding.

### AI Chat (Knowledge Q&A)

Core intelligent Q&A interface based on SSE streaming, providing a smooth AI conversation experience:

- **⚡ Streaming Dialogue**: AI outputs responses word by word in real time for instant feedback
- **📎 File Upload**: Supports images (JPG/PNG/GIF) and documents (PDF/Word/Excel/PPT/TXT/MD, etc.)
- **👁️ Image Understanding**: Upload images to invoke vision model for recognition and analysis
- **🖼️ Multimodal Dialogue**: When multimodal is enabled, supports simultaneous image + text input, directly understood by the multimodal model without file summarization
- **📄 File Summary Enhancement**: Automatically summarizes uploaded documents to enhance AI dialogue context
- **🔍 RAG Knowledge Enhancement**: Retrieves relevant knowledge from question bank and course syllabus to improve answer accuracy
- **📜 Chat History**: Auto-saved and shown by conversation title, grouped by today/yesterday/month, with title and full-text search, hover preview, rename and download
- **👁️ HTML Preview**: One-click preview of HTML code blocks in conversations
- **📋 Example Prompts**: Built-in multiple teaching scenario examples, one-click fill
- **🎭 Three Modes**: Smart Answer Mode / Companion Mode (Student) / Assistant Mode (Teacher/Admin)
- **🎤 Voice Input**: Supports microphone voice-to-text input
- **📷 Photo Upload**: Supports camera photo capture and direct upload

> **Available to all logged-in users**

---

### AI Companion (Student Exclusive)

An intelligent upgrade of AI dialogue, providing personalized learning companionship for students:

- **👤 Dedicated Learning Partner**: The AI companion knows the student's name, grade, learning progress, and weak knowledge points
- **🔄 Three Personality Modes**:
  - 🌟 **Encouraging**: Warm and enthusiastic, full of positive energy, uses encouraging language
  - 📐 **Rigorous**: Precise and detailed, focuses on analyzing "why it's wrong" and "how to fix it", draws inferences
  - 😄 **Humorous**: Witty and fun, appropriately uses memes and banter to make learning enjoyable
- **📊 Learning Profile Sidebar**: Real-time display of title, points, weak knowledge points, exam trends, consecutive learning days
- **🔔 Proactive Push**: Morning greetings, exam result analysis, title upgrade congratulations, learning reminders
- **💾 Unified Chat History Management**: Shares the same chat history system as Smart Answer mode
- **⚙️ Custom Settings**: Customizable companion name, personality, toggle companion on/off, daily wake-up time
- **🎨 Visual Differentiation**: Purple companion-style chat bubbles and avatar

> **Available to students (switch at the top of the Smart Answer page)**

---

### Course Exercises (Knowledge Point Practice)

AI-powered practice system based on course syllabus knowledge points:

- **🤖 AI Auto-Generated Questions**: Teachers generate 10 multiple-choice questions per knowledge point with one click
  - AI intelligently searches and merges matching questions from the question bank
  - Gaps are filled by AI-generated new questions
  - New questions are automatically added to the question bank
- **✍️ Student Online Answers**: Click on knowledge points in the course learning page to practice directly
- **🏆 Auto Points Reward**:
  - Participation base: 2 points
  - Excellent (≥90%): +15 points
  - Good (≥75%): +10 points
  - Pass (≥60%): +5 points
- **📊 Data Display**: Dashboard shows completion count and average accuracy rate
- **📋 Growth Portfolio Integration**: Personal portfolio page integrates practice details

> **Admin/Teacher can create questions; Student can participate in exercises**

---

### Targeted Practice (AI-Directed Questioning)

Teachers generate targeted practice questions from wrong answer books or knowledge points and push them to classes or specific students:

- **🤖 AI Question Generation**: Automatically generates targeted practice questions from wrong answer books or knowledge points
- **📤 Targeted Push**: Push to class or specific students
- **✍️ Student Answering**: Online answering, supports multiple-choice and short-answer questions
- **🤖 AI Auto-Grading**: Short-answer questions are automatically graded
- **⚡ Async Question Generation**: Non-blocking, supports background generation
- **📊 Practice Records**: View history and performance statistics

> **Admin/Teacher can create questions; Student can participate**

---

### Wrong Answer Review

Automatically collects student wrong answers for AI-assisted review:

- **📋 Wrong Answer Collection**: Grouped by exam for display
- **✅ Mark as Mastered**: Each wrong question can be marked mastered (and undone), with To review / Mastered / All filtering actually in sync
- **📐 Multimedia Display**: Supports LaTeX formulas and image display
- **🤖 AI Review Plan**: One-click generation of personalized review reports (wrong answer analysis, knowledge point review suggestions, targeted practice questions)
- **👁️ Three-Level Linked Viewing (Teacher)**: Filter by grade → class → student
- **📊 Wrong Answer Statistics**: Wrong answer count and accuracy rate by subject

> **Student views their own; Teacher/Admin can view all students in a class**

---

### Daily Picks & Trending News

Dual knowledge expansion modules, allowing students to easily broaden their horizons beyond regular study:

- **📖 Daily Picks**: AI fun knowledge card pool; each person randomly draws 6 cards,
  7-day deduplication window, supports favorites and manual refresh. Smart knowledge pool replenishes on demand,
  no consumption when unused, browsing earns points and badges.
- **📰 Trending News**: RSS aggregation of mainstream news feeds (Chinanews, IT Home, etc.),
  AI on-demand summaries + subject association, supports daily briefing, favorites and paginated browsing (no longer capped at the first 20 items).
  2h cache lazy loading, 72h rolling cleanup, zero fetching when no one is accessing; the source list is editable in system config, with a per-source circuit breaker and a standby pool.

> **Available to all users**

---

### Programming Practice (Code Exercises)

Online programming practice and auto-grading system:

- **Teacher Side**:
  - Create programming problems (problem description, test cases, sample code)
  - AI code review
  - View submission statistics and student code
- **Student Side**:
  - Online coding (syntax highlighting, supports Python)
  - Run and debug (custom input)
  - Submit for grading
- **🤖 Auto-Grading Engine**:
  - AST static analysis + sandbox execution
  - Per-test case output comparison
  - Supports Python
  - Timeout control (10 seconds)
- **🔒 Security Sandbox**:
  - Dangerous module blacklist
  - Dangerous function interception
  - Temporary directory isolation

> **Available to all logged-in users**

---

<a id="ch-practice"></a>

## Classroom Activities

The real-time tools that run a single 40-minute lesson: quizzes, polls, questions, drills, buzzer rounds, discussions, the whiteboard, roll call, quests and the assignment centre.

### Classroom Interaction Tools

#### Class Quiz

Classroom instant quiz system:

- ✏️ Visual editor creation (multiple-choice/multi-select/true-false)
- 🤖 One-click AI generation (specify topic/question type/quantity): the bank comes first, AI only fills the shortfall and those questions are saved back for reuse
- 📊 Auto-grading and result statistics
- 📐 Supports LaTeX formulas and images
- 📤 Data export

#### Classroom Voting

Classroom instant voting system:

- 📋 Single/multiple choice modes
- 🤖 AI auto-generates voting topics
- 📊 Real-time bar chart statistics
- 👥 Real-time participant count display

#### Question Management

Integrated student Q&A and teacher approval management:

- 🙋 **Student Questions**: Students initiate questions (supports anonymous)
- 🤖 **AI-Assisted Answering**: AI automatically generates suggested answers, teachers can modify before publishing
- 👨‍🏫 **Teacher Answering**: Teachers answer directly or approve student-provided answers
- ✅ **Approval Mechanism**: Teachers can mark student answers as "approved" or "not approved"
- 🔒 **Permission Control**: Only visible to students and teachers in the same class

> **Students can ask questions; Teachers can manage answers and approvals**

---

### Quick-Answer Competition

Real-time multiplayer online quick-answer competition system:

- **Teacher Side**:
  - Create competition rooms (set time limit, question count, subject)
  - Question sources: the bank comes first, AI generates the shortfall and stores it; built-in questions are a last resort when AI cannot deliver, and never repeat
  - Control competition process (start/next question/end)
  - View real-time leaderboard
- **Student Side**:
  - Enter 6-digit room code to join
  - Timed answering (speed-based decreasing scoring)
  - Combo bonus (5 consecutive correct answers = 2x score)
  - Real-time ranking
- **Scoring Rules**:
  - Speed scoring: 0-3s = 100 pts, 3-7s = 70 pts, 7-11s = 40 pts, 11+s = 20 pts
  - Combo multiplier: 2 consecutive = 1.2x, 3 = 1.5x, 4 = 1.8x, 5+ = 2.0x
  - 3 consecutive wrong answers: -10 pts
  - All correct: additional 1.2x bonus
- 📊 **Activity Review**: Leaderboard, per-question accuracy statistics

> **Admin/Teacher can create and manage; Students can participate**

---

### Group Discussion (AI Tutor)

AI tutor-assisted classroom group discussion system:

- **Create Discussion**:
  - Group modes: No grouping (free discussion area) / Auto-group / Random group
  - AI tutor roles: Observer / Guide / Active Participant / Debate Judge / **Composite Role (Smart Switching)**
  - AI intelligently generates discussion plans (supports Markdown format titles and descriptions)
- **Participate in Discussion**:
  - Students enter discussion room for real-time chat, can expand to view discussion topic descriptions
  - AI tutor automatically participates according to role
  - Real-time message push (WebSocket)
- **Discussion Management**:
  - 👁️ **Monitoring Panel**: Teachers view all group dynamics in real time
  - 🛡️ **Content Moderation**: Automatically detects inappropriate speech, deducts points for violations
  - ⏹️ **End Discussion**: AI automatically generates structured summary report
  - 📄 **Word Export**: AI summary can be exported as Word document
- 📊 **Summary Report**: Key viewpoints, AI evaluation, group scores

> **Admin/Teacher can create and manage; Students can participate in class discussions**

---

### Collaborative Whiteboard (AI Whiteboard Assistant)

Real-time collaborative whiteboard system based on TLDraw, with built-in AI whiteboard assistant sidebar:

- **Three Teaching Modes**:
  - 📺 **Presentation Mode**: Teacher displays, students view only
  - 🤝 **Interactive Mode**: Teacher authorizes students to operate
  - 📝 **Self-Study Mode**: Students operate independently
- **🔗 Room System**: Teacher creates rooms (supports class/course/temporary types), students enter 6-digit room code to join
- **👥 Real-Time Member Management**: Online member list showing currently online students
- **🎨 Whiteboard Tools**: Pen, shapes (rectangle/ellipse/diamond/arrow), text, sticky notes, images, laser pointer
- **📄 Multi-Page Support**: Supports multiple pages with thumbnail navigation
- **🤖 AI Whiteboard Assistant** (Teacher Exclusive):
  - 💬 **Streaming Dialogue**: AI combines whiteboard current content for contextual Q&A, supports vision-enhanced understanding
  - 🖼️ **Generate Diagrams**: Automatically generates teaching diagrams based on descriptions (SVG preferred)
  - 📝 **One-Click Boarding**: Automatically generates structured board content based on knowledge points
  - ✨ **Beautify Layout**: Rearranges messy whiteboard content into clear and beautiful board writing
  - 🏷️ **Smart Annotation**: Automatically analyzes selected content and provides annotation suggestions
  - 🌳 **Mind Map**: Automatically generates structured mind maps based on board content
  - 🌐 **Bilingual**: One-click conversion of board content to Chinese-English bilingual version
  - 💡 **Teaching Suggestions**: Recommends next teaching steps based on current whiteboard content
  - ❓ **Class Quiz Questions**: Automatically generates classroom practice questions based on board content
  - 🔍 **Solve Problems**: Identifies and analyzes problems from images on the whiteboard
  - 👁️ **Vision Understanding**: Switches to vision mode to understand whiteboard image content via multimodal model
  - 📄 **Export Summary**: AI generates structured classroom summary and exports as Word document

> **Admin/Teacher can create and manage; Students can participate**

---

### Attendance & Roll Call Management

Integrated smart roll call + attendance statistics management:

- **🎲 Weighted Random Roll Call**: dynamic weights, decay on pick, new round after 60% coverage — kept **per class, keyed by student ID**, shared with questioning, ladder and AI quiz pages
- **🧾 Pick records**: one cross-activity timeline with activity/class filters, per-activity stats, most-picked, Excel export and "new round"
- **🗣 Voice announcement**: the picked student's name is spoken aloud (polyphonic surnames auto-corrected), enabled by the admin in System Settings
- **✅ Roll Call Records**: Mark correct/incorrect, view history and statistics
- **📊 Roll Call Statistics**: Per-person statistics on times called and accuracy rate
- **📝 Attendance Records**: Automatically records each login time, IP, browser information
- **📅 History Tracking**: Complete login history records
- **👁️ Permission Control**: Teachers view only their own class, Admin can view all

> **Available to Admin and Teacher**

---

### Class Ladder (Big Screen)

A **single-player ladder** for the projector — one session can run all lesson long:

- **🎯 15-level ladder**: level 1 worth 10 up to level 15 worth 50 (415 total), accumulating; levels 5 and 10 are safe levels (a wrong answer keeps what you have earned)
- **🎲 Questions**: a subject alone is enough (the knowledge point is optional or can be typed); the bank comes first with per-level difficulty, AI fills the gap and stores new questions
- **👤 Fair picking**: shares roll call's class weights; every pick lands in Pick records, with voice announcement
- **💡 Three lifelines** (one use each per run, discounts stack): 50:50 (×0.85), phone a friend (×0.70), ask the audience (×0.70)
- **🧮 Server-side judging**: the answer is never sent to the client; the student taps an option and the server judges and reveals it
- **🏆 Automatic rewards**: the run settles straight into classroom points (levels cleared) and leaves a record on the student's timeline
- **📊 Session board and settle screen**: a wrong answer or timeout triggers a full-screen result with the explanation; the board refreshes live and the next student starts a new run
- **🎨 7 big-screen skins**: defaults to the light "Cloud" theme; Sunrise / Mint (light) and Star / Cyber / Academy / Classic (dark) are also available
- **🔊 One sound switch**: covers both big-screen effects and the name announcement
- **⌨️ Keyboard friendly**: `Space` draw, `1-4` pick, `Enter` submit, `0` skip
- **🖥 Built for the projector**: students never use their own devices

> **Teachers and admins (limited to their own classes); points are awarded by levels cleared**

---

### Class Drill

A big-screen "draw a question → pick a student → answer" loop for warm-ups and in-class questioning, repeatable as long as you like:

- **🎲 Two ways to get questions**: pick a course knowledge point (searchable dropdown) or type one, then draw from the question bank; limited to single-choice and true/false
- **🤖 AI generation behind a switch**: when on, the bank still comes first and AI only fills the gap — **those questions are stored**, so next lesson the same knowledge point hits the bank directly; the admin can turn this feature's AI off in System Settings (zero AI cost while off)
- **👤 Fair picking**: shares the class weights of roll call and questioning, with voice announcement; "ask a helper" picks are logged too
- **✍️ Tap to answer**: the student taps an option; on submit the server judges it and reveals the answer and explanation
- **🏆 Instant scoring**: correct +5, wrong +2, skipped 0 — points go to the existing classroom points and show up in points management
- **♻️ Loop as long as you like**: picking a new student clears the previous choice and the revealed answer, so one lesson can keep going
- **⌨️ Keyboard friendly**: `Space` pick, `1-4` choose, `Enter` submit, `0` skip, `N` next
- **🖥 Built for the projector**: students never use their own devices; phones show a "use the desktop app" notice

> **Teachers and admins (teachers limited to their own classes)**

---

### Assignments (Chat / Files)

One entry, two submission types: **chat transcript** (students work it out with the AI and hand in the conversation) and **files** (Word / PDF / spreadsheets / slides / images). Both are graded by the AI first and published by the teacher after review:

- **Teacher Side**:
  - Pick the submission type when creating homework; for file assignments set the deadline, allowed types, file count and size, attempts, full score and scoring dimensions
  - Requirements are the rubric: AI splits them into 3-5 checkpoints and judges each one against the submitted content
  - AI grading: chat homework is graded in one call; file homework runs as a background job (images are read by a vision model first, then the whole class is graded from a single package) with live progress
  - The grading board shows each student's files, extracted text or image preview, per-dimension scores, checkpoints with quotes from the work, similarity flags and a zip download of every original
  - Edit scores and comments freely - the original AI score is kept for comparison
  - Students see results only after "Publish grades", which also awards the grade-level bonus points
- **Student Side**:
  - See active assignments, the deadline countdown and how many attempts are left
  - Chat homework: submit the current conversation in one click; file homework: drag and drop or take a photo on a phone, resubmit before the deadline (only the last attempt is graded, late ones are just tagged)
  - Download your own originals, and after publication view total score, dimension scores, checkpoints, comments and next steps
- **📖 How to use**: the button next to the title opens step-by-step guidance for students and teachers
- **🧮 Math rendering**: formulas in transcripts and requirements display correctly, even written in the same line as the text

> **Available to all users, differentiated by role**

---

### Knowledge Challenge

AI instant-question knowledge challenge:

- **🎯 Challenge Rules**: Timed answering (30 seconds per question), game over on wrong answer, max 15 questions
- **🤖 AI Questioning**: AI instantly generates encyclopedia questions (supports question bank mode)
- **💡 Three Power-Ups** (one use per game):
  - 🎯 **Remove One**: Eliminates one wrong option
  - 📞 **Call for Help**: AI gives a hint
  - 👥 **Crowd Wisdom**: AI simulates voting results
- **📊 Scoring Rules**: Tiered scoring (Q1: 10 pts → Q15: 50 pts), power-ups reduce score
- **🏆 Achievement Badges**: Novice / Challenge Rookie / Challenge Adept / Challenge Master / Challenge Legend / Undefeated / 10-Streak
- **📊 Teacher Management**: View student challenge records, manage challenge question bank, AI batch question generation
- **📋 Challenge History**: Statistics on total attempts, max correct count, total score

> **Students can participate; Teacher/Admin can manage question bank and view records**

---

<a id="ch-assess"></a>

## Analytics and Motivation

Behaviour becomes a learner profile, the profile feeds teaching, and points, titles and honours keep the loop positive.

### AI-Powered Learning Analytics

Utilizes AI for in-depth analysis of teaching data:

- **📊 Class Learning Report**:
  - Overall evaluation
  - Learning highlights
  - Weak area analysis
  - Teaching improvement suggestions
  - Supports Word export
- **📋 Exam Analysis Report**:
  - Score distribution statistics
  - Per-question accuracy analysis
  - Class comparison
  - Teaching improvement suggestions
- **📤 Data Export**: Supports Word export

> **Available to Teacher and Admin**

---

### AI Classroom Summary

AI comprehensively analyzes classroom interaction data:

- **🤖 Smart Analysis**: AI analyzes class quizzes, votes, questions, and other interaction data
- **📋 Summary Report**: Overall situation, participation analysis, knowledge point mastery, teaching suggestions
- **📄 Word Export**: Supports Word document export
- **📊 Class Filtering**: Filter analysis scope by grade/class

> **Available to Teacher and Admin**

---

### Progress Details

Comprehensive analysis of course progress and learning progress:

- **📖 Course Progress**: View chapter/knowledge point completion status of all students by course, expand for details
- **📊 Learning Progress**: View comprehensive student statistics by class (course progress/completion rate/accuracy rate/consecutive learning days), supports filtering individual students
- **🔍 Permission Control**: Teachers see only their own classes, Admin sees all

> **Available to Teacher and Admin**

---

### Activity Monitoring (Teaching Supervision)

Teachers view completion status of various teaching activities:

- **📋 Activity Types**: Exams, smart practice, quick-answer competitions, tasks, class quizzes, code exercises, group discussions, votes, course exercises
- **👥 Completion Status**: Completed / Not completed student lists
- **📊 Score Overview**: Brief scores and statistics
- **🔍 Multi-Dimensional Filtering**: Filter by activity name, grade, class
- **📥 Data Export**

> **Available to Teacher and Admin**

#### Activity Data Reset (clear participation, keep content)

All nine activity types (Exam, Smart Practice, Quick Quiz, Online Task, Class Quiz, Code Practice, Group Discussion, Quick Poll, Course Exercise) provide a "Reset" action:

- **🧹 What is cleared**: data produced by student participation (answers, submissions, votes, messages, group rosters and reports, AI grading results, resource views and learning progress) plus derived data (point ledger rows, activity notifications, wrong-question entries)
- **📦 What is kept**: the activity content itself — questions and options, paper structure and marks, code statements and test cases, discussion settings, room codes, task IDs. Deleted participation records cannot be recovered
- **🔎 Preview before delete**: a dry-run preview lists every data item and its row count; toggling an option recalculates immediately, so the numbers shown are exactly what will be deleted (same rules as execution)
- **🔁 Status rollback**: optionally return the activity to a re-joinable state (e.g. Exam Ended → Published, Quick Quiz Playing → Waiting) without touching content
- **⌨️ Second confirmation**: the activity name must be typed; the phrase is validated on the server, so calling the API directly cannot bypass it
- **📩 Student notice**: an acknowledgement can be pushed to affected students and is rendered in the reader's UI language (no leftover Chinese in English mode)
- **🧮 Points**: after revoking the activity's ledger rows, affected students' totals are recomputed immediately using the same rules as the daily reconciliation (no title upgrades)
- **🛡️ Permissions**: administrators can reset everything (resetting another user's activity is flagged as an override in the audit log); teachers may only reset activities they created — for course exercises this requires being both the resource owner and a teacher of that grade; students see no entry point and every endpoint rejects them
- **📝 Audit trail**: every reset writes a full audit record (operator and role, activity id/type/title, options, deleted rows per table, points revoked, students affected, students notified, timestamp)

> Every activity type shares the same reset flow (pick scope → preview → confirm → audit trail); new activity types get it for free.

---

### Resource View Tracking

Tracks student viewing of HTML and download resources:

- **📊 Statistics Overview**: Active student count, total views, viewed resource count
- **📋 Resource Details**: View count and viewing time per resource
- **👤 Student Details**: Resource viewing details per student
- **📚 Knowledge Point Binding**: View resource access by course knowledge point
- **🏆 Points Reward**: First viewing of shared resources automatically rewards 1 point

> **Available to Teacher and Admin**

---

### Data Export

Supports exporting various data to Excel/CSV:

- 📊 Exam score export
- 📊 Cross-activity score summary: filter scores and completion by grade/class/student/activity type/date, export multi-sheet Excel or CSV
- 📊 Roll call record export
- 📊 Classroom interaction data export
- 📊 Activity monitoring data export
- 📊 Resource view tracking export

> **Available to Teacher and Admin**

---

### Points Reward System (Auto Reward Engine)

The student "Point rules" dialog and the teacher "Points management" banner are both rendered from `GET /api/rewards/rules`.
The single source of truth is `REWARD_CONFIG` in `backend/reward_engine.py` — this table
is only a documentation mirror of it.

- **Two kinds of points**: participation (awarded for taking part, regardless of correctness)
  + grade bonus (only activities with a standard answer)
- **Grade bonus scales with an activity weight**: "score rate" always means earned / full marks; for class ladder it is the ladder score rate, since that mode ends on the first wrong answer and earned-over-attempted would be ~1 by construction. Base tiers use the exam scale —
  Excellent +15 / Good +10 / Pass +5 (score rate ≥90% / ≥75% / ≥60%, one payout per tier per activity)

| Activity | Participation | Grade bonus (E / G / P) | Daily quota |
| --- | :---: | :---: | :---: |
| Exam | 3 | 15 / 10 / 5 | academic pool 80 |
| Class quiz | 2 | 9 / 6 / 3 | academic pool 80 |
| Synced / course practice | 2 | 9 / 6 / 3 | academic pool 80 |
| Task (incl. file submissions) | 3 | 9 / 6 / 3 | academic pool 80 |
| Code practice | 2 | 9 / 6 / 3 | academic pool 80 |
| Knowledge challenge | 1 | 6 / 4 / 2 | academic pool 80 |
| Roll call | 1 | correct answer adds Good +4 | class pool 40 |
| In-class pick | 1 | correct answer adds Good +4 | class pool 40 |
| Class ladder | 2 | 6 / 4 / 2 (by **ladder score rate** = earned / 415) | class pool 40 |
| Classroom Q&A (approved answers add a quality bonus) | 2 | 6 / 4 / 2 | class pool 40 |
| Group discussion (joining + each message) | 2 | 6 / 4 / 2 | 10/day, inside class pool |
| Quick vote · Learning progress · Daily login | 2 / 2 / 1 | — | class pool 40 |
| Mistake fix | 1 | — | 5/day |
| Quick-answer competition | 2 | rank bonus: 1st +6 / 2nd +5 / 3rd +4 / 4th-5th +3 / 6th+ correct +1 | 3 scored rounds/day |
| AI chat (incl. companion) | 2 | — | 10/day |
| Resource / Daily picks / News browsing | 1 | — | 5 / 5 / 3 per day |

- **Three daily quota pools**: academic 80 / class participation 40 / light activities 30
  (all tunable in System settings, 0 = unlimited). Farming buzzers or chat can only fill
  its own pool and no longer swallows the grade bonus earned from a real exam
- **Deductions vs. spending are separate ledgers**: moderation failures write `penalty`,
  exchanging points (e.g. an extra AI portrait) writes `spend`; the ledger colour-codes
  negatives, so "I spent points" no longer reads as "I was punished"
- **Teacher recognition channel**: `POST /api/rewards/award-quality` grants an Excellent /
  Good / Pass bonus for one specific question, discussion message or answer
- **🏅 12-level titles**: Novice → Foundation Apprentice → Diligent Newcomer → Knowledge Hunter
  → Problem-Solving Pro → Logic Rising Star → Academic Pioneer → Class Scholar
  → Innovation Leader → Omnipotent Prodigy → Legendary Master → Supreme Sage
  (thresholds 0 / 10 / 30 / 60 / 110 / 170 / 240 / 330 / 450 / 600 / 780 / 1000, calibrated to one active term)
- **📚 Subject titles**: level comes from questions answered per subject, then capped by accuracy
  (<60% tops out at "Apprentice", 60–75% at "Proficient"), levels only go up, stats refresh nightly
- **🎖️ Achievement badges**: including All-Rounder (8 different activity types), Punctual (3 exams
  submitted before the deadline), Monthly Persistence (20 study days in a month) and the
  challenge / reading series — locked badges now show how much is still missing
- **⭐ Weekly stars**: students see their **own class** board with a denominator
  (rank N of M); grade-wide and school-wide boards stay on the teacher side
- **🏫 Class ranking**: total points (the teacher-side "combined score" also includes manual
  classroom marks — the two are deliberately different metrics)

> **Available to admins/teachers; students can view** rules, daily quotas, ledger, titles, subject titles and badges.

---

### Classroom Points (Class Management)

Classroom points incentive system:

- ⭐ Each teacher independently manages points
- 📊 Points leaderboard (ranking within class)
- 👥 Student management (add/deduct points)
- 💾 Data persisted to database
- 📤 Supports import/export

> **Admin/Teacher available; Student can view**

---

### Hall of Glory (Student Honor Showcase Wall)

Integrated student achievement display page, bringing together points, titles, badges, and other honors on one wall:

- **🎴 Card Display**: One honor card per student, showing title banner, points star rating, badge wall, subject titles
- **🎨 10 Gradient Theme Skins**: Golden Glory, Deep Sea Exploration, Forest Story, Cherry Blossoms, Aurora Dreamscape, Sunset Afterglow, Starry Voyage, Jade Porcelain Elegance, Flaming Fighting Spirit, Minimalist White
- **🔄 Theme Adaptation**: 12-level titles automatically map to themes, supports manual switching (🎨 palette button)
- **❤️ Like Interaction**: Card likes + particle animation effects, view count statistics
- **🔍 Multi-Dimensional Filtering**: Search by grade/class/name, supports multi-dimension sorting (points/title level/likes/views)
- **👨‍🏫 Teacher Management**: Permission control by teaching grade/class, supports batch generate/refresh/delete
- **🔄 Auto Sync**: Each generation automatically pulls latest points, title, and badge data

> **All users can view; Teacher/Admin can manage**

---

### Student Growth Portfolio

Full-dimension learning data aggregation profile:

- **📋 Comprehensive Summary**: AI-generated personalized learning evaluation
- **📊 Five-Dimension Statistics**: Exams, points, roll call, tasks, conversations
- **📈 Score Trend Chart**: Score change trend across exams
- **🏆 Points Trend Chart**: Points accumulation curve
- **⏱️ Growth Timeline**: All learning activities displayed chronologically
- **📄 Word Learning Report Export**
- **👁️ Permission Control**: Students view themselves; Teacher/Admin can view any student
- **📊 Course Exercise Integration**: Exercise statistics and details

> **Available to all logged-in users**

---

### My Portrait

A personalised illustration (AI portrait) drawn with Tongyi Wanxiang from the learning data of the current period:

- **🤖 AI Image Generation**: Generates exclusive portraits based on user platform data (points, title, learning/teaching data)
- **🎭 15 Creative Styles**:
  🔮 Magic Academy | 💻 Cyber Scholar | 🖌️ Chinese Ink | 🚀 Space Explorer | 💥 Action Comics
  🧚 Fairy Tale Elf | ⚙️ Steampunk | 🎮 Pixel World | 🎭 Dunhuang Flying Apsaras | 🌌 Aurora Dreamscape
  🦸 Superhero | ⚔️ Temple Knight | 🦋 Cyber Elf | 🐚 Ocean Explorer | ⏳ Time Traveler
- **📝 Creative Messages**: Large model automatically generates stylized messages based on user data (martial arts, interstellar, classical, etc.)
- **👤 Role-Aware**: Automatically adjusts portrait identity and message tone based on Student/Teacher/Admin
- **🗓️ Configurable period**: one portrait per week by default, switchable to monthly in system configuration; the period decides both the free allowance and which slice of data the portrait is built from (this week / this month), so the name matches the content
- **📊 Data attribution**: identity comes from lifetime data (title, total points, streak) while performance comes from **this period** (points earned, activities, exams, new wrong answers, chats, resource views) — lifetime numbers are never described as "this week"
- **🖼️ Personal Gallery**: Historical portraits displayed chronologically, tagged with the period they cover
- **🌐 Sharing Gallery**:
  - School-wide gallery / Class gallery / Popular recommendations
  - Like interaction
  - Three privacy scopes: Public / Class-visible / Private
- **🔒 Image compliance**: stylised illustrations only — the image prompt carries no real name or gender and never aims at a photorealistic face (K12 context)
- **⏰ Generation Limit**: one free portrait per period, then points as configured; teachers/admins are free but capped per period
- **🩺 Generation health**: admins see the last 7 days' success rate, average duration and common failures; a failed image can be retried without spending allowance or points

> **Available to all logged-in users**

---

<a id="ch-manage"></a>

## System Management

Accounts, configuration, AI skills, notifications, upgrades and operations.

### User Management

Complete account management system:

- **📝 Register Users**: Supports three roles: Admin, Teacher, Student
- **✏️ Update Information**: Modify username, class, grade, name, gender, role, teaching subjects
- **🔑 Change Password**: All users can change their own password; Admin can reset others' passwords
- **🗑️ Delete Users**: Single or batch delete
- **📤 CSV Import**: Batch import users
- **🔍 Filter & Search**: Filter by role/grade/class, search by username/name
- **🏫 Teacher Assignment**: Set teacher's teaching grades, classes, and subjects
- **🧩 Class Management**: review per-class student and teacher counts, clean up empty shell classes (Admin only)
- **📊 Batch Grade Promotion/Demotion**: One-click preview and execute, intelligently sync points and roll call data
- **🔒 Security Settings**: Security questions (forgot password self-service recovery)
- **🔐 Single Sign-On**: Token version control, remote login kickout

> **Admin and Teacher available; Student can only change password**

---

### System Announcements

Publish and manage system announcements:

- **📝 Publish Announcement**: Title, content, priority (Normal/Important/Emergency)
- **📌 Pin Function**: Pin important announcements to top
- **👥 Visibility Scope**: Limited by role (Student/Teacher/Admin), grade, class
- **📋 Announcement List**: Paginated display, sorted by priority
- **✏️ Edit/Delete**: Manage published announcements

> **All users can view; Admin and Teacher can publish**

---

### System Configuration

Centralized management of all system configuration parameters:

- **🏷️ Brand Info**: Platform version name, organization name
- **🔑 API Keys**: DashScope API Key
- **🤖 Model Configuration**: APPID, API address, default chat model, long-text model, vision model, multimodal switch (all chosen from dropdowns)
- **💬 AI Chat Settings**: Chat permission roles, daily request quota (switch plus limit)
- **⚙️ System Limits**: File size limit, token validity, online timeout, IP protection and login gates
- **🔊 Speech Synthesis**: master switch, synthesis model (two generations), voice (grouped per model, follows the model switch), speech rate, volume, synthesis self-test
- **📚 Course Settings**: Course name list, question types
- **🔔 Notifications**: Enabled notification types
- **📁 File Type Whitelist**: Image/document extensions
- **🎨 Image Generation**: toggle, model (dropdown, endpoint dispatched automatically), size (defaults to auto, options follow the model), per-question auto-image cap, image self-test
- **⚡ Knowledge Challenge**: Question mode (question bank/AI)

> **Admin only**

---

### Skill Management

Modular AI Skill Document System — each skill is defined via YAML + Markdown, automatically injected into AI calls by scene:

- **🧩 20 Pre-installed Skills**: 8 core + 12 domain-specific
- **🎯 Scene-Aware Injection**: controls which scenes each skill applies to
- **⚡ Three-Stage Quality Enhancement**: Deep Analysis → Structured Output → Self-Review
- **📋 Visual Management**: Search, filter by type, pagination, toggle all on/off
- **🔍 Detail Preview**: View raw skill document, version, tags, priority
- **🛡️ Safe Degradation**: Skills silently skip on error, zero impact on existing features

> **Admin only**

---

### Notification Center

Real-time message notification system:

- 🔔 Top bar bell displays unread notification count in real time
- 📋 Notification list (All/Unread filter)
- ✅ Mark as read / Mark all as read
- 🗑️ Delete notifications
- 🔄 Auto-triggered scenarios:
  - Exam published/changed/ended
  - Resource sharing
  - Version update notifications
  - Submission grading completed
- ⚙️ Notification types can be enabled/disabled in System Configuration

> **Available to all logged-in users**

---

### Online Upgrade System (Version Management)

Git-based online incremental upgrade system:

- **🔍 Check for Updates**: Automatically compares with the latest GitHub version
- **📥 Incremental Upgrade**: Automatically executes git fetch → git reset → database migration → pip install → restart
- **📊 Progress Visualization**: Real-time progress bar and log output
- **⏪ One-Click Rollback**: Automatically rolls back on upgrade failure, also supports manual rollback
- **📋 Upgrade History**: Complete records of each upgrade (time, version, changed file list)
- **🔧 Environment Diagnostics**: Automatically checks Git installation, .git directory, remote configuration, network connectivity
- **🤖 Background Auto-Check**: Polls every 6 hours, notifies admin of new versions
- **🔒 File Lock**: Prevents concurrent upgrades by multiple IIS Workers

> **Admin only**

---

### About System

| Feature | Description |
| --- | --- |
| ❓ **About System** | View documentation |

---

### Other System Services

| Feature | Description |
| --- | --- |
| 🔑 **Change Password** | All users can change their own password |
| 🔐 **Forgot Password** | Self-service password recovery via security questions |
| 🗑️ **Temp File Cleanup** | Automatically cleans temporary upload files older than 24 hours |
 | 🎨 **Multi-theme appearance** | Theme switcher in the top bar: default blue-white, forest green, sunset orange, midnight starry and lavender purple; the choice is stored locally and is available on the sign-in page too |

<a id="changelog"></a>

## Changelog

Current version **9.0.0**. Only changes a reader can notice are listed; per-commit detail lives in the git history. Everything up to v8.9.0 is merged into one outline section below.

### v9.0.0

**Security**

- 🔒 **Path traversal in static file serving fixed**: files could be pulled off the server without logging in; only paths inside the site directory are served now, and the API listing page is off by default in production
- 🩹 **Views of shared files never attached to a resource**: the query passed one parameter too many, so the view count stayed empty

**Mistake book and auto consolidation**

- 📕 **The mistake book is now card-based**: one question reads top to bottom — stem, your answer against the correct one, explanation, knowledge points; the figure sits beside the stem and drops below it on narrow screens instead of breaking out of the card
- 🧠 **Mistakes carry explanations**: explanations already in the bank show in a collapsible block, and missing ones can be AI-generated straight into the bank — **empty slots only, never overwriting a teacher's text**
- 🎨 **Right and wrong no longer rely on colour alone**: icon + text label + tint, theme colours throughout so dark mode works; status is a tag and actions are buttons, so “mastered” no longer reads like a state
- 🔎 **Filter, group, batch, export**: real counts on pending / mastered / all, grouping by exam, topic or question type, keyword and topic filtering, batch mark-as-mastered, and a Word export grouped by source with answer comparison and explanations
- 🔁 **Auto consolidation practice revived**: an unanswered set no longer blocks future ones (stale sets are closed after the interval); pushes send a notification that opens the set directly; a cooldown and a daily cap keep it from swinging to the opposite extreme; selection prefers frequently-missed and long-neglected questions and avoids recent sets; teachers see the policy and each student's state, and can push a set on demand
- 🧭 **Admins choose the sources**: tick which activities feed the mistake book in system settings — exams are always included — and the page states its current scope. Only activities whose questions can be traced back to the bank are offered
- 🧭 **Teacher-targeted practice is visible again**: sets pushed to named students and auto-consolidation sets used to vanish from the student home page and to-do list; they are listed now, with consolidation sets ranked first and one click straight into the answers
- 🩹 **Students who only did practice or class questioning can now be reached**: the grade, class and student pickers used to list only students with exam submissions
- 🧷 **Quick-quiz mistakes can be traced again**: quiz questions never recorded which bank question they came from, so nothing could reach the mistake book
- 🧷 **A mistake keeps its origin**: getting it wrong again inside a consolidation set only raises the counter, it no longer rewrites which exam the mistake came from; existing rows were re-attributed to the earliest exam where the student missed them
- 🩹 The student-side “consolidate mistakes” button now actually works (draw a set or resume the unfinished one) instead of only showing a note; retired questions are labelled as such

**Resource centre and content types**

- 🗂️ **Three share tabs with consistent semantics**: a new "My shares" tab lists only what you actually shared out (admins included; private registrations to yourself are not listed), "Shared with me" became "Shared by colleagues", and admin management addresses shares by record instead of guessing from the path
- 🔁 **Re-sharing really works and merges**: one physical file shared by several people is now a single card that honestly notes who else shared it
- 🧩 **Resource binding rebuilt**: one registry replaces six hard-coded type lists (fixing "change one, miss five"), synchronous practice is on the shelf, and the candidate list gained a facet sidebar, a card picker, real totals and an explicit truncated flag
- 🏷️ **Web resources now have a content-type system**: 11 types (courseware, animation, course practice, chapter practice, interactive quiz, lab simulation, podcast, custom page, activity, handout, unclassified); an explicit mark wins over filename guessing, artifacts are classified when written, **follow renames and are cleared on delete**
- ✍️ **Types can be set by hand**: click the tag in My resources, on a share card, in the binding picker or in resource management (tree and grid) to reclassify, with a content-type filter on top; a gold tag with a dot is a human mark and can be cleared back to filename inference
- 🗃️ **One-click grouping for ungrouped resources**: by content type, chapter (Chapter N) or section (N.M), previewing which groups are created or reused and how many items each takes before anything is written; already grouped files are never touched
- ✂️ **Two kinds of practice separated**: `{point_id}_{title}_{timestamp}_练习.html` is **course practice** (answers recorded with a score) while a name ending in 练习题 is a **chapter exercise** (a generated page that records nothing). Both used to share one value shown as chapter practice; the tag now explains the difference on hover
- 🩹 **The “My shares” sort box leaked an internal value**: both share tabs read one local preference, so a sort option from one leaked into the other; preferences are now stored per tab and validated, and view and page size no longer overwrite each other

**Question bank, courses and import**

- 📊 **Creator breakdowns in bank analytics no longer truncate**: types were capped at the top 5 and subjects at the top 3, so the smallest subject — typically a newly added one — vanished while its questions still counted in the total. Both now list everything and act as filters
- 📥 **Bulk import explains every failed row** instead of "row 3 failed", naming the column and what is missing
- ⚡ **Question management is faster**: production build, duplicate requests removed, cells re-render only when they change
- 🗂️ **Knowledge point chapter fixed**: the editor shows the chapter name instead of a bare id, and switching chapters really saves

**Phones and images**

- 📱 **Detail tables became cards**, fixing six places that could not be read on a narrow screen
- 🖼️ **Avatars and portrait images broke with 401 on every client**; protected image URLs now carry the token

**System administration**

- ⚙️ **System settings rebuilt**: 105 settings regrouped by scenario into 4 groups and 24 sections (a new "Answer Quality" section), with a left tree switching sections and a single-column right pane; 46 everyday settings are visible, 59 advanced ones (memory budgets, grading cadence, audit thresholds) fold into "Advanced"
- 🎛️ **Control types fixed**: rank visibility, skill injection position and default ladder skin became dropdowns instead of free text; quest question source and portrait period became radio groups instead of switches; the question-type list became a dialog editor with separate key and label fields and duplicate detection
- 🧩 **Login gate merged into one card**: student, teacher and external logins share a single explanation; the latter two previously had none
- 📝 **Copy fixed and terminology unified**: the panel counter reported the number of groups as sections ("5 sections" where there are 24); AI concurrency is now marked "takes effect after restart" and no longer contradicts the "no restart needed" footer; the outdated "restart required" note on subjects is gone; Markdown asterisks and hard line breaks were removed; terminology unified to login token, AI endpoint and edition name
- 🔒 **Edits are no longer lost**: saving after switching sections or searching no longer clears other sections, leaving with unsaved changes is intercepted, "reload from server" asks for confirmation, and the unsaved counter opens a change list
- 🧪 **New consistency check**: `scripts/check_system_config.py` verifies field counts, section membership, zh/en coverage, Markdown leftovers and enum options — a field added without a section or a translation fails loudly

**Fixes**

- 🩹 The class ladder failed to load completion, with roster matching and the reset owner column fixed along the way
- 🩹 AI teaching suggestions were missing a prompt import deleted during the 8.8.0 refactor; three same-root risks were fixed in the same pass

### v7.x – v8.9.0 (outline)

- ⚖️ **Points and honour system reworked**: grade bonuses follow activity weight (exam 15/10/5, quizzes · homework · practice 9/6/3, classroom answers 6/4/2), buzzers pay by placing, the ladder pays by score rate; anti-farming quotas split into three pools (academic 80 / participation 40 / light 30); every classroom activity awards points; one source of truth served by the backend
- 🏅 **Titles and badges recalibrated**: twelve thresholds re-cut, six permanently locked badges lit up, subject titles weigh accuracy, locked badges show what is missing; deductions and spending separated, weekly stars scoped to the class, a new teacher recognition channel
- 📎 **File-submission homework**: documents, spreadsheets, slides and photos, one AI pass for the whole class with teacher review before publishing; three attempts, only the last is graded, lateness only flagged; a grading desk with duplicate flags and bulk download
- 🏁 **Class ladder (big screen)**: 15 levels, safe levels, ends on a wrong answer or timeout, AI top-up questions, seven skins and full-screen settlement
- 🎲 **Unified picking**: roll call, questioning, ladder and AI quiz share one set of weights and one ledger keyed by student ID, with a cross-activity log, per-activity stats and Excel export
- 🖼️ **My portrait**: all three roles can use a portrait as their avatar and pin any one (past periods included); staff portraits are as visible as students' and outside the points system
- 💻 **Question management**: multi-select bulk delete with a reason per skipped item; a denser list shows about 40% more per screen; code in stems and explanations renders as real code blocks, same convention in Word papers and AI quiz pages
- 🗂️ **Course management**: soft disable plus a recycle bin; the course list returns active courses only by default, with a switch to view, restore or delete permanently
- 🔧 **Deployment and polish**: skills on by default; per-form upgrade paths with GitHub as the authoritative source; the knowledge-point panel collapses and turns into a drawer on narrow screens
- 🩹 **Fixes**: same-named classmates sharing one roll-call points key (existing rows re-keyed), whiteboard AI generation always failing, handshake and polling log spam, points and portfolio details unreadable on phones, broken portrait avatars, raw key names leaking, participation capped at 100, missing-table warnings on a fresh database
- 💬 **Classroom interaction**: question submission de-dup, idempotency and async review, teacher filtering, anonymity, follow-ups, popularity and live refresh; in-class picking and AI podcasts added
- 🧩 **Teaching flow**: unified knowledge-point input across the site; draft/publish state machine for practice and quizzes; card-style activity lists; completion scoped to the activity; student answer drafts and submission guards
- 🧱 **Question bank and results**: single ingestion path with validation, dedup, transactions and knowledge-point links; paper composition prefers the bank with AI top-up; unified result tabs with per-question accuracy and AI analysis; bank analytics (type / difficulty / subject / knowledge point / creator / quality) with subjects constrained to the configured courses
- 📊 **Analytics and summaries**: class and time-window snapshots, corrected exam/task/roll-call semantics and teacher scoping, explicit AI failure hints, reports persisted for export reuse; summary export fixed for submitted/pending semantics and best-of repeats
- 💬 **Group discussion**: editable list, real-student pre-grouping on start, random and automatic grouping, WebSocket no longer reconnects per message, idempotent rate-limited optimistic messages, posting locked after the end
- 🎨 **Classroom and incentives**: collaborative whiteboard rebuilt, browsing statistics, my portrait, hall of glory auto-cards, point recomputation and activity-reset auditing, challenge records and bank bulk delete
- 📰 **Content management**: teacher and admin consoles for daily picks and news with health checks, single and bulk disable, restore and delete
- 🔒 **Security and operations**: authorisation and privilege scoping, async AI calls, unified paper and grade semantics, online upgrade and login hardening, model configuration and self-checks
- 🎯 **Earlier releases**: AI skill system and bilingual UI, hall of glory and themed UI, daily picks and RSS news, AI companion and lesson prep, platform-wide removal of subject hard-coding

<a id="deployment"></a>

## Deployment Guide

### Method 1: One-Click Install · SmartKBS Desktop (no environment needed)

Don't want to install Python or Node.js? Use the desktop installer — double-click and go.

1. Download the latest installer: [SmartKBS latest release](https://github.com/youufis/SmartKBS/releases/latest) (redirects to the newest release)
   (file name looks like `SmartKBS-Setup-<version>.exe`, ~120 MB, **Windows x64 only**)
2. Run it: wizard (Simplified Chinese), pick your install folder, desktop and Start Menu shortcuts are created for you
3. Launch SmartKBS: the built-in backend starts on its own and the app window opens once port `8086` is ready
4. Local access at `http://127.0.0.1:8086`; students on the same LAN use `http://LAN-IP-of-this-machine:8086` (e.g. `http://192.168.1.100:8086`)
   (click "Allow access" on the first Windows Firewall prompt, or other devices can't reach it)

| Item | Notes |
| --- | --- |
| Runtime dependencies | None — no Python / Node.js needed (Electron shell + PyInstaller backend + Vite frontend) |
| Data location | `%APPDATA%\SmartKBS\` (database, uploads, logs) — **survives uninstall and reinstall** |
| Upgrading | Use 「System Config → Version Management → Check Update」; when a newer build is found, install the new package over the old one (data is kept). The Git-style online incremental upgrade does not apply to the desktop edition. |
| Port | Fixed `8086`. If the web edition already runs on this machine under IIS, stop it first or the desktop app won't start |
| Platforms | Only a Windows x64 installer is published today; macOS / Linux packaging is configured but not released |

### Method 2: Download Source Package (requires Python)

1. Download the latest source code ZIP from GitHub: [youufis/SmartKBS](https://github.com/youufis/SmartKBS)
2. Extract to server directory (e.g., `D:\SmartKBS`)
3. Install Python dependencies:

   ```bash
   pip install -r requirements.txt
   ```

4. Start the service:

   ```bash
   python backend/main.py
   ```

### Method 3: Git Clone Deployment (Recommended, Supports Online Upgrade)

```bash
git clone https://github.com/youufis/SmartKBS.git
cd SmartKBS
pip install -r requirements.txt
python backend/main.py
```

### Online Upgrade System (Git Deployment Only)

If deployed via `git clone`, system upgrades are fully automated:

1. Admin login → System Configuration → **Version Management**
2. Click "Check for Updates", system automatically compares with the latest GitHub version
3. Click "Incremental Upgrade", automatically executes:

   ```text
   git fetch (incrementally pull diff code) → git reset (sync files)
   → database migration → pip incremental install → restart service
   ```

4. Automatic rollback on failure, real-time progress display

> **💡** The first time you click "Incremental Upgrade", the system automatically runs `git init` + `git remote add` to initialize the local repository — no manual configuration needed to enjoy online upgrades.

### PIP China Mirror Acceleration

```bash
pip install -r requirements.txt -i https://mirrors.aliyun.com/pypi/simple/
```

---

<a id="quickstart"></a>

## Quick Start

**Requirements**

- Python **3.11+** (3.11.9 is what development and packaging were tested on)
- Node.js only if you want to develop the frontend; the desktop edition bundles everything

### Step 1: start the backend

```bash
# Option 1: run directly
python backend/main.py

# Option 2: run with Uvicorn (dev mode, hot reload)
python -m uvicorn backend.main:app --host 0.0.0.0 --port 8086 --reload
```

The backend listens on `http://localhost:8086` and serves the prebuilt frontend in `frontend/dist`, so no extra setup is needed.

### Step 2: start the frontend dev server (only when developing the frontend)

```bash
cd frontend
npm install
npm run dev
```

The dev server runs on `http://localhost:5173` and proxies API calls to the backend.

### Step 3: sign in as the default administrator

| Username | Password |
| --- | --- |
| `root` | `root` |

> 🔑 Change this password and set security questions immediately — never leave the default credentials in a real deployment.

### Step 4: configure the AI service

Open System Configuration and enter your DashScope API Key (plus the optional knowledge base / agent application and DeepSeek keys). The page lists candidate models and ships with connectivity self-tests, so you know right away whether a setting works.

With no AI service configured, the core flows — question bank, exams, roll call, resources, points — still work; AI entry points simply explain what is missing.

---

<a id="structure"></a>

## Project Structure

**Shipped with the source (tracked in the repository)**

```text
SmartKBS/
├── backend/                      # FastAPI backend
│   ├── main.py                   # entry: routers, static hosting
│   ├── config.py                 # global configuration constants
│   ├── database.py               # business DB smartkb.db + grade/class master data
│   ├── question_db.py            # question bank DB questions.db
│   ├── auth.py                   # JWT · bcrypt · token-version SSO
│   ├── middleware.py             # auth middleware and role correction
│   ├── permission_service.py     # unified grade/class permissions
│   ├── rag.py                    # retrieval over question bank and syllabus
│   ├── bailian_kb.py             # Bailian knowledge-base search
│   ├── ai_task_manager.py        # asynchronous AI jobs
│   ├── question_fill.py          # filling policy (bank first, AI fills the gap)
│   ├── question_select.py        # selection engine
│   ├── paper_compose.py          # paper composing and score balancing
│   ├── paper_generator.py        # Word paper generation (python-docx)
│   ├── reward_engine.py          # points reward engine
│   ├── title_system.py           # 12-level titles + achievement badges
│   ├── companion_*.py            # AI companion: memory / settings / proactive push
│   ├── code_grader.py            # automatic code grading
│   ├── code_runner.py            # sandboxed code execution
│   ├── whiteboard_ws.py          # whiteboard WebSocket manager
│   ├── ws_manager.py             # discussion WebSocket manager
│   ├── tts_service.py            # speech synthesis (roll-call voice)
│   ├── model_catalog.py          # model catalogue and capability limits
│   ├── skill_engine.py           # AI skill injection engine
│   ├── api/                      # 49 modules: business routers + AI invocation and image service
│   │   ├── ai_service.py         # unified AI invocation (three modes)
│   │   ├── image_gen_service.py  # Wanxiang image generation
│   │   └── *_router.py           # exams / bank / interaction / analytics / whiteboard …
│   ├── prompts/                  # prompt templates grouped by scene
│   ├── skills/                   # 20 skills: 8 core + 12 domain (*.skill.md)
│   ├── locales/                  # backend messages zh-CN / en
│   └── migrations/               # database migrations
├── frontend/                     # React + Vite + TypeScript frontend
│   ├── src/
│   │   ├── api/                  # API wrappers
│   │   ├── components/           # shared components
│   │   ├── pages/                # pages
│   │   ├── stores/               # Zustand state
│   │   ├── hooks/                # custom hooks
│   │   ├── types/                # type definitions
│   │   ├── i18n.ts               # language switch entry
│   │   └── styles/               # themes
│   └── dist/                     # prebuilt bundle served by the backend
├── requirements.txt              # Python dependencies
├── version.json                  # current version and changelog (read by the online upgrade)
├── LICENSE                       # AGPL-3.0
├── README.md · README.en.md      # Chinese and English docs
└── .markdownlint.json            # documentation rules
```

**Created at runtime, not shipped** (auto-created on first start; this is also what you back up)

| Directory / file | Contents |
| --- | --- |
| `backend/smartkb.db` | users, points, roll call, tasks, notifications and other business data |
| `backend/questions.db` | question bank and exam data |
| `backend/system_config.json` | runtime configuration (subjects, models, API keys) — kept out of the repository because it holds secrets |
| `root/`, `stu/` | admin and per-student data directories (chat history, teaching HTML, portraits) |
| `question_media/` | question figures, one directory per question id |
| `temp_uploads/` | temporary uploads, purged after 24 hours |
| `LogFiles/`, `backend/logs/` | logs |
| `db_backups/`, `.upgrade_backups/` | database backups and upgrade rollback snapshots |

> 🖥️ The desktop edition (Electron + PyInstaller) is a local build and its project folder is not distributed with the source; installers are published through GitHub Releases and keep data in `%APPDATA%\SmartKBS\`.

---

<a id="storage"></a>

## Data Storage

| Data Type | Storage Location |
| --- | --- |
| Core business data (users/points/roll call/tasks/notifications, etc.) | `backend/smartkb.db` (SQLite) |
| Question bank and exam data | `backend/questions.db` (SQLite) |
| Chat history | `<user_dir>/ChatHistory/` organized by date |
| Teaching resources | `<user_dir>/html/` independent per account |
| System configuration | `backend/system_config.json` |
| User API Key | Environment variable `DASHSCOPE_API_KEY` / System Configuration |
| Question images | `question_media/` organized by question ID |
| Temporary upload files | `temp_uploads/` (auto-cleaned after 24 hours) |
| My portraits | `<user_dir>/portraits/` |
| Whiteboard snapshots | Database `whiteboard_pages` table |

---

> 💾 **Backup checklist** — to migrate or restore, keep `backend/smartkb.db`, `backend/questions.db`, `backend/system_config.json` and the `root/`, `stu/`, `question_media/` directories; for the desktop edition, back up the whole `%APPDATA%\SmartKBS\` folder.

---

<a id="permissions"></a>

## Permissions Overview

| Page / Feature | Student | Teacher | Admin |
| --- | :---: | :---: | :---: |
| Dashboard | ✅ | ✅ | ✅ |
| AI Chat (Smart Answer Mode) | ✅ | ✅ | ✅ |
| AI Companion Mode | ✅ | ❌ | ❌ |
| AI Teaching Assistant Mode | ❌ | ✅ | ✅ |
| Course Syllabus (Learning) | ✅ View/Practice | ✅ Manage | ✅ Manage |
| Course Progress Tracking | ❌ | ✅ Own Class | ✅ All |
| Question Bank Management | ❌ | ✅ | ✅ |
| Exam Center (Taking) | ✅ | ✅ Manage | ✅ Manage |
| Smart Paper Generation & Word Export | ❌ | ✅ | ✅ |
| Targeted Practice | ✅ Participate | ✅ Create | ✅ Create |
| Course Exercises | ✅ Practice | ✅ Create | ✅ Create |
| Daily Picks | ✅ | ✅ | ✅ |
| Trending News | ✅ | ✅ | ✅ |
| Assignments (chat / files) | ✅ Submit | ✅ Manage | ✅ Manage |
| To-Do Items | ✅ | ❌ | ❌ |
| Resource Center (Browse Shared) | ✅ | ✅ | ✅ |
| Resource Management | ❌ | ✅ | ✅ |
| Resource Category Navigation | ✅ | ✅ | ✅ |
| File Center | ✅ Shared Files | ✅ | ✅ |
| Classroom Points | ✅ View | ✅ Own Class | ✅ All |
| Points Reward System | ✅ View | ✅ Own Class | ✅ All |
| Roll Call Management | ❌ | ✅ Own Class | ✅ All |
| Attendance Statistics | ❌ | ✅ Own Class | ✅ All |
| Class Drill | ❌ | ✅ Own Class | ✅ All |
| Class Ladder | ❌ | ✅ Own Class | ✅ All |
| Class Quiz | ✅ Answer | ✅ Create | ✅ Create |
| Classroom Voting | ✅ Vote | ✅ Create | ✅ Create |
| Question Management | ✅ Ask | ✅ Approve | ✅ Manage |
| Group Discussion | ✅ Participate | ✅ Manage | ✅ Manage |
| Quick-Answer Competition | ✅ Participate | ✅ Manage | ✅ Manage |
| Knowledge Challenge | ✅ Play | ✅ Manage | ✅ Manage |
| Code Practice | ✅ | ✅ | ✅ |
| Wrong Answer Review | ✅ Own | ✅ Whole Class | ✅ Whole Class |
| Learning Analytics | ❌ | ✅ Own Class | ✅ All |
| Progress Details | ❌ | ✅ Own Class | ✅ All |
| Growth Portfolio | ✅ Own | ✅ Whole Class | ✅ Whole Class |
| AI Classroom Summary | ❌ | ✅ | ✅ |
| My Portrait | ✅ | ✅ | ✅ |
| Collaborative Whiteboard | ✅ Participate | ✅ Create | ✅ Create |
| Activity Monitoring | ❌ | ✅ | ✅ |
| Activity Data Reset | ❌ | ✅ (own activities only) | ✅ (all activities) |
| Resource View Tracking | ❌ | ✅ | ✅ |
| AI Resource Recommendations | ❌ | ✅ | ✅ |
| AI-Generated HTML Resources | ❌ | ✅ | ✅ |
| AI Podcast (generate) | ❌ | ✅ | ✅ |
| Data Export | ❌ | ✅ | ✅ |
| User Management | Change Password Only | ✅ Partial | ✅ Full |
| System Announcements | ✅ View | ✅ Publish | ✅ Publish |
| Notification Center | ✅ | ✅ | ✅ |
| System Configuration | ❌ | ❌ | ✅ |
| Online Upgrade (Version Management) | ❌ | ❌ | ✅ |
| Multi-Theme System | ✅ | ✅ | ✅ |
| About System | ✅ | ✅ | ✅ |

---

<a id="tech-stack"></a>

## Tech Stack

| Layer | Technology |
| --- | --- |
| Backend | Python 3.11+ · FastAPI · Uvicorn |
| Frontend | React 19 · TypeScript · Vite 8 |
| UI library | Ant Design 6 |
| Charts | Recharts |
| Markdown and formulas | react-markdown · KaTeX |
| Code editor | Monaco Editor (code practice) |
| Whiteboard engine | tldraw 5 |
| State and routing | Zustand · React Router 7 |
| Internationalisation | i18next (whole UI switchable zh/en, messages on both sides) |
| Database | Two SQLite files (business + question bank), no external database |
| Auth | JWT (bcrypt + PyJWT), token versioning for single sign-on |
| AI models | Qwen via DashScope · DeepSeek |
| AI invocation modes | knowledge-base RAG / Bailian agent app / direct model, taken over by priority with step-down fallback |
| Image generation | Wanxiang (wanx2.1 / wanx2.2) |
| Speech synthesis | DashScope TTS (roll-call voice, optional) |
| Streaming and realtime | Server-Sent Events (AI streams) · WebSocket (whiteboard / discussions / buzzer) |
| Export | python-docx (Word) · openpyxl (Excel) |
| Formula images | matplotlib (optional enhancement, degrades to Unicode text) |
| Code sandbox | AST static analysis + subprocess isolation |
| Desktop edition | Electron + PyInstaller + Vite bundle (Windows x64 installer only) |

---

<a id="license"></a>

## License

This project is released under the **AGPL-3.0**; the full text lives in [LICENSE](LICENSE).

- ✅ You may use, modify and distribute it freely, including deploying it inside a school;
- ⚠️ If you modify it and **offer it over a network**, you must publish your modified source under the same licence;
- ℹ️ Systems that only talk to SmartKBS through its API and are independent of it are not affected.

Copyright © 2026 youufis (UNET)

---

<a id="faq"></a>

## FAQ

- **I forgot my password.** If security questions were set, use "Forgot password" on the login page; otherwise ask an administrator to reset it in User Management.
- **The AI chat does not answer.** Confirm the API key is filled in and funded under System Configuration, then run the built-in connectivity self-test — it tells you whether the model, the knowledge base or the agent application is at fault.
- **Uploads fail.** Documents are capped at 10 MB and images at 5 MB (the image cap is configurable), and the extension plus content whitelist must match.
- **The companion or the assistant will not open.** The companion is student-only, the assistant is teacher/admin-only. A teacher also needs a grade and class scope set in User Management, otherwise the assistant has no teaching range to work with.
- **The exam will not submit.** Check that the current time is inside the exam window and that attempts remain. If a teacher is refused while editing questions, that is the in-flight answer lock protecting students who are still writing.
- **Classroom points did not increase.** Only activity types that support points award them, automatically on completion, and a configurable daily cap applies; teachers and admins are excluded from points and leaderboards. Title upgrades need the corresponding score percentage.
- **I upgraded or edited code but the UI looks unchanged.** Hard-refresh (Ctrl+F5). Changes involving WebSocket, speech synthesis and AI timeout behaviour need a **backend restart**.
- **How do I upgrade?**
  1. Git deployment: as admin open System Configuration → Version Management, then Check for Updates and Incremental upgrade; failures roll back automatically.
  2. Source package: unzip the new release over the old directory, keeping `backend/system_config.json` and the two `.db` files, then restart.
  3. Desktop edition: run the new installer over the old one; data in `%APPDATA%\SmartKBS\` is preserved.
- **A fresh machine refuses to start.** Confirm Python is 3.11+, reinstall dependencies with `pip install -r requirements.txt`, and if a module is reported missing check whether it is listed there.

---

<a id="about"></a>

## About

**SmartKBS** — an AI-powered smart teaching platform for primary, junior secondary and senior secondary schools, with subjects, grades and classes driven by configuration.

- 👨‍💻 **Author:** youufis (UNET)
- 📧 **Contact:** [youufis@sina.com](mailto:youufis@sina.com)
- 💬 **WeChat:** UNET-WX
- 📄 **License:** [AGPL-3.0](LICENSE)

The project is developed and maintained by one person, with its release rhythm shaped by real classroom use — that is where decisions such as "question bank before AI" and "no idle compute" come from. Open an issue or write an email for bugs and feature requests.
