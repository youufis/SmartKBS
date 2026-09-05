# SmartKBS — AI-Powered Smart Teaching Platform

> **🌐 [English](README.en.md) | [中文](README.md)**
> AI-Powered Smart Teaching Management Platform for All Grades and Subjects — **Suitable for Any Subject, Any Grade Level**
>
> Integrated AI streaming dialogue, learning companion/assistant, question bank, online exams, intelligent test paper generation & Word export,
> course syllabus, classroom interaction (class quiz/voting/Q&A), group discussion (AI tutor),
> quick-answer competitions, knowledge challenge, code practice, automated code grading,
> points reward system (12-level titles + achievement badges), classroom points, smart roll call, attendance statistics,
> wrong answer review, targeted practice, course exercises, daily picks, trending news, AI resource recommendations, learning analytics, growth portfolio,
> AI self-portrait, collaborative whiteboard, class summary, activity monitoring, resource view tracking,
> task management with AI grading, user management, system announcements, notification center,
> online incremental upgrade, multi-theme appearance system, comprehensive grade-class system, and **50+ functional modules**.
>
> Built with **FastAPI + React**, deeply integrated with Alibaba Cloud DashScope and DeepSeek AI capabilities.

![Version](https://img.shields.io/badge/Version-8.0.0-blue)
![Backend](https://img.shields.io/badge/Backend-FastAPI-green)
![Frontend](https://img.shields.io/badge/Frontend-React%2BTypeScript-blue)
![AI](https://img.shields.io/badge/AI-DashScope%20%7C%20DeepSeek-orange)
![License](https://img.shields.io/badge/License-AGPL--3.0-red)

---

<div style="display:flex;flex-wrap:wrap;justify-content:center;gap:0 6px;">

<a href="#-project-introduction">📋 Project Introduction</a> · <a href="#-demo-environment">🎮 Demo Environment</a> · <a href="#-complete-feature-overview">✨ Feature Overview</a> · <a href="#-changelog">📦 Changelog</a> · <a href="#-deployment-guide">📦 Deployment Guide</a> · <a href="#-quick-start">🚀 Quick Start</a> · <a href="#-project-structure">📁 Project Structure</a> · <a href="#-data-storage">💾 Data Storage</a> · <a href="#-permissions-overview">👥 Permissions Overview</a> · <a href="#-tech-stack">🔧 Tech Stack</a> · <a href="#-license">📄 License</a> · <a href="#-faq">❓ FAQ</a> · <a href="#-about">📬 About</a>

</div>

---

> 📌 **V8.0.0 Highlights**:
> 🔒 **Site-wide authorization hardening**: 16 rounds of feature-by-feature audit, anonymous reads and cross-teacher writes closed
> 🎯 **Roll call & class interaction**: ownership pinned to the login identity, publish scope limited to assigned classes, class analytics fixed
> ⚙️ **System config & skills**: atomic writes with backup fallback, value validation, masked secret echo
> 📝 **i18n completion**: untranslated keys in security setup, question bank, paper composer, announcements, interaction and whiteboard filled (zh/en)
> 🧹 **Resource center**: stale bindings auto-purged on rename, per-type file icons, cleaner share statistics

---

## 📋 Project Introduction

**SmartKBS** is a fully-featured AI-powered smart teaching management platform designed for all grades and subjects, specifically tailored for primary, middle, and high school education scenarios. The system is not limited to any specific subject — through flexible configuration, it can adapt to mathematics, Chinese, English, physics, chemistry, biology, history, geography, information technology, general technology, artificial intelligence, and any other subject's teaching needs.

Built with **FastAPI + React**, the system adopts a modern front-end/back-end separation architecture, deeply integrating Alibaba Cloud DashScope (Tongyi Qianwen/Tongyi Wanxiang) and DeepSeek large language model capabilities. Through a flexible AI invocation service (supporting both Bailian Agent application and direct model invocation modes), it provides teachers and students with a one-stop intelligent teaching and learning experience.

> 💡 **Core Design Philosophy**
>
> - **🧠 AI Native, Full-Scenario Integration**
>   AI is not an external tool, but a native capability running through teaching, learning, practice, assessment, and management.
>   Every conversation, every question, every report has deep AI involvement,
>   yet teachers and students "don't feel the presence of AI" — it blends naturally into the teaching flow.
>
> - **🎯 Teach According to Aptitude · Personalized for Everyone**
>   The student-side AI companion dynamically adjusts conversation style and recommended content
>   based on grade, knowledge weak points, and learning habits; the teacher-side AI assistant
>   provides precise lesson preparation support and learning insights tailored to the teacher's classes, subjects, and time periods.
>
> - **🔄 Teaching Loop · Data Flywheel**
>   From learning behavior collection → AI analysis → personalized feedback → behavior improvement,
>   forming a complete data flywheel. Every exam, practice, and conversation enriches
>   the student profile, which in turn feeds back into subsequent AI decisions.
>
> - **⚡ Anti-Waste Architecture · Zero Idle AI**
>   All AI calls are triggered on demand — no access means no resource consumption.
>   Daily pick pool, trending news cache, AI summary lazy loading
>   ensure every bit of computing power is used where it matters.
>
> - **👥 Role-Aware · Dual-Wheel Drive**
>   Student → AI Companion (accompanying learning), Teacher → AI Assistant
>   (workload reduction), Admin → Global intelligent control.
>   Each plays their part without interference.
>
> - **🏆 Gamified Incentives · Intrinsic Drive**
>   12-level title system + achievement badges + points reward engine,
>   transforming the learning process into a rewarding growth journey.
>   Motivation comes not from external pressure, but from continuous positive feedback.
>
> - **🌐 Subject-Agnostic · Flexible Adaptation**
>   Any subject, any grade level can be quickly adapted through configuration.
>   AI prompts are dynamically constructed — no code changes needed to switch curricula.

---

## 🎮 Demo Environment

> **🌐 Demo URL:**
>
> **Development Environment:** [http://youufis.oicp.net:8086](http://youufis.oicp.net:8086) / [https://youufis.oicp.net:8085](https://youufis.oicp.net:8085)
>
> **Deployment Environment:** [http://183.239.51.37:8086](http://183.239.51.37:8086) / [https://183.239.51.37:8085](https://183.239.51.37:8085)
>
> **👤 Test Accounts:**
>
> | Role | Username | Password |
> | --- | --- | --- |
> | Teacher | youufis | ultraultra |
> | Student | s11001 ~ s11009 | 123456 |
> | Student | s18001 ~ s19009 | 123456 |

---

## ✨ Complete Feature Overview

#### 🏠 Home Overview

### 📊 Dashboard (System Home)

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

### 📋 To-Do Items (Student Task Aggregation)

Student-specific task aggregation board:

- 📊 To-do items grouped by category (Assessments, Course Learning, Interactive Classroom, Shared Resources, System Services)
- 🔴 Upcoming deadline highlights
- 🚀 One-click jump to corresponding feature pages
- 📈 Completion progress statistics

> **Available to students**

---

#### 📚 Teaching Management

### 📖 Course Syllabus (Course Guide)

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

### 📚 Course Exercises (Knowledge Point Practice)

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

### 💬 AI Chat (Knowledge Q&A)

Core intelligent Q&A interface based on SSE streaming, providing a smooth AI conversation experience:

- **⚡ Streaming Dialogue**: AI outputs responses word by word in real time for instant feedback
- **📎 File Upload**: Supports images (JPG/PNG/GIF) and documents (PDF/Word/Excel/PPT/TXT/MD, etc.)
- **👁️ Image Understanding**: Upload images to invoke vision model for recognition and analysis
- **🖼️ Multimodal Dialogue**: When multimodal is enabled, supports simultaneous image + text input, directly understood by the multimodal model without file summarization
- **📄 File Summary Enhancement**: Automatically summarizes uploaded documents to enhance AI dialogue context
- **🔍 RAG Knowledge Enhancement**: Retrieves relevant knowledge from question bank and course syllabus to improve answer accuracy
- **📜 History Records**: Auto-saved, browsable by date, tree view, full-text search
- **👁️ HTML Preview**: One-click preview of HTML code blocks in conversations
- **📋 Example Prompts**: Built-in multiple teaching scenario examples, one-click fill
- **🎭 Three Modes**: Smart Answer Mode / Companion Mode (Student) / Assistant Mode (Teacher/Admin)
- **🎤 Voice Input**: Supports microphone voice-to-text input
- **📷 Photo Upload**: Supports camera photo capture and direct upload

> **Available to all logged-in users**

---

### 🧠 AI Companion (Student Exclusive)

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

### 🎓 Teaching Assistant (Teacher/Admin Exclusive)

AI-powered teaching tool assistant for teachers and administrators:

- **📝 Smart Lesson Planning**: Automatically generates complete lesson plans based on topics (teaching objectives, teaching process, classroom activities, homework design)
- **📄 Auto Exam Generation**: Generates exam papers and class quizzes by knowledge point/question type/difficulty
- **📊 Learning Analytics**: Analyzes class or individual student performance data, identifies weak points and areas for improvement
- **🎯 Activity Planning**: Designs classroom interaction plans (group discussions, quick-answer, class quizzes, etc.)
- **📋 Teaching Data Sidebar**: Real-time display of student count, exam statistics, task submissions, classroom interactions, and other teaching overviews
- **🎨 Visual Differentiation**: Teal-green assistant-style chat bubbles and avatar

> **Available to Teacher/Admin (switch at the top of the Smart Answer page)**

---

### 📝 Targeted Practice (AI-Directed Questioning)

Teachers generate targeted practice questions from wrong answer books or knowledge points and push them to classes or specific students:

- **🤖 AI Question Generation**: Automatically generates targeted practice questions from wrong answer books or knowledge points
- **📤 Targeted Push**: Push to class or specific students
- **✍️ Student Answering**: Online answering, supports multiple-choice and short-answer questions
- **🤖 AI Auto-Grading**: Short-answer questions are automatically graded
- **⚡ Async Question Generation**: Non-blocking, supports background generation
- **📊 Practice Records**: View history and performance statistics

> **Admin/Teacher can create questions; Student can participate**

---

### 📝 Question Bank Management (Smart Question Bank)

AI-powered smart question management system supporting multiple question types and multimedia:

- **🤖 One-Click AI Generation**: Automatically generate questions by subject, type, knowledge point, difficulty, and quantity
- **📤 Smart Extraction**: Supports pasting text or uploading .docx/JSON files, automatically identifies types, options, and answers
- **📋 Supported Types**: Multiple-choice, multi-select, true/false, short answer, fill-in-the-blank, essay, subjective
- **📐 Formula Support**: Full support for LaTeX formula ($...$) rendering display
- **🖼️ Image System**:
  - SVG drawing for technical diagrams
  - Tongyi Wanxiang generates realistic images
  - Supports image generation, preview, deletion, concurrent generation optimization
  - Image placeholder management
- **📂 Question Bank Management**: Category filtering, search, edit, delete
- **🔄 AI Image Generation**: Automatically generates images for subjective question SVG/image placeholders

> **Available to Admin and Teacher**

---

### 📝 Exam Publishing (Online Exam System)

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

### 📄 Smart Paper Generation & Word Export

Step-by-step guided paper generation wizard supporting smart selection and professional document export:

- **📋 Configuration Wizard**: Question type and quantity configuration, difficulty distribution, knowledge point range filtering
- **🤖 AI Smart Selection**: Intelligent matching by knowledge point
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

### 📕 Wrong Answer Review

Automatically collects student wrong answers for AI-assisted review:

- **📋 Wrong Answer Collection**: Grouped by exam for display
- **📐 Multimedia Display**: Supports LaTeX formulas and image display
- **🤖 AI Review Plan**: One-click generation of personalized review reports (wrong answer analysis, knowledge point review suggestions, targeted practice questions)
- **👁️ Three-Level Linked Viewing (Teacher)**: Filter by grade → class → student
- **📊 Wrong Answer Statistics**: Wrong answer count and accuracy rate by subject

> **Student views their own; Teacher/Admin can view all students in a class**

---

### 📁 Resource Center (Sharing Center)

Displays HTML teaching resource files in a card grid:

- **👁️ Card Browsing**: Thumbnail + file name
- **🔗 Sharing Operations**:
  - **Admin Sharing**: Can select "Everyone", "Specific Teacher", "Specific Grade/Class"
  - **Teacher Sharing**: Select "Admin and Teachers" + "Own Classes"
- **🔍 Search & Filter**: Search by file name
- **🤖 AI Generation**: 5 resource types (Animation Explanation, Interactive Quiz, Chapter Exercise, Lab Interaction, Custom HTML)
- **👁️ Resource View Tracking**: Automatically records student viewing behavior

> **Available to all logged-in users; Students can only view shared resources**

---

### 📁 Resource Management

Upload/delete/rename teaching resource files:

- 📤 Upload files, directories (HTML/CSS/JS/images/documents, etc.)
- 🗑️ Delete and rename
- 📁 Each teacher has an independent resource directory
- 🔗 File sharing operations (same as Resource Center sharing)
- 📊 Quota management

> **Available to Admin and Teacher**

---

### 🤖 AI Teaching Resource Recommendations

Intelligently recommends teaching resources based on knowledge point content:

- **🔍 Smart Analysis**: AI analyzes knowledge point content and automatically recommends related resources
- **📋 Recommendation Types**: HTML courseware, exam papers, classroom discussions, class quizzes, tasks
- **🔗 One-Click Binding**: Recommended resources can be directly bound to knowledge points
- **📄 AI-Generated Courseware**: AI can automatically generate complete HTML courseware based on knowledge points

> **Available to Admin and Teacher**

---

### 🤖 AI-Generated HTML Resources

Use AI directly in the Resource Center to generate HTML teaching resources:

- **📄 5 Resource Types**:
  - 🎬 **Animation Explanation**: 3D parallax, particle animations, etc. to vividly explain knowledge
  - ✍️ **Interactive Quiz**: Card-based interactive answering, including multiple-choice questions and instant feedback
  - 📝 **Chapter Exercise**: Structured exercises with question number navigation and submit button
  - 🧪 **Lab Interaction**: Algorithm visualization, math/physics/chemistry experiments, AI interactive simulation
  - 🎨 **Custom HTML**: Freely input topics, generate any HTML as needed
- **🎭 Theme Selection**: Multiple preset themes for each type
  - Animation 17 types, Quiz 20 types, Exercise 10 types, Lab 12 types
- **📚 Question Bank + AI Mixed Questioning**: Automatically matches questions from the question bank, AI supplements shortfalls
- **💾 AI New Questions Auto-Added**: AI-generated questions are automatically saved to the question bank
- **🔗 Subject/Grade Smart Association**: Fetches corresponding question bank based on subject and grade

#### 🧪 Lab Interaction Resource Details

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

### 📥 File Center

Download directory file management:

- 📤 Upload / 📥 Download / 🗑️ Delete
- 📊 Quota management (independent quota per teacher)
- 📁 Subdirectory support
- 🔗 Directory sharing (entire directory automatically inherits permissions)
- 👁️ Students can view shared files

> **Available to Admin and Teacher; Students can view shared files**

---

#### 🌐 Knowledge Expansion

### ⭐ Daily Picks & 📰 Trending News

Dual knowledge expansion modules, allowing students to easily broaden their horizons beyond regular study:

- **📖 Daily Picks**: AI fun knowledge card pool; each person randomly draws 6 cards,
  7-day deduplication window, supports favorites and manual refresh. Smart knowledge pool replenishes on demand,
  no consumption when unused, browsing earns points and badges.
- **📰 Trending News**: RSS aggregation of 5 major official sources (Xinhua, CCTV, etc.),
  AI on-demand summaries + subject association, supports daily briefing and favorites.
  2h cache lazy loading, 72h rolling cleanup, zero fetching when no one is accessing.

> **Available to all users**

---

#### 💻 Programming Practice

### 💻 Programming Practice (Code Exercises)

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

#### 🎪 Classroom Activities

### 🎯 Classroom Interaction Tools

#### 📋 Class Quiz

Classroom instant quiz system:

- ✏️ Visual editor creation (multiple-choice/multi-select/true-false)
- 🤖 One-click AI generation (specify topic/question type/quantity)
- 📊 Auto-grading and result statistics
- 📐 Supports LaTeX formulas and images
- 📤 Data export

#### 📊 Classroom Voting

Classroom instant voting system:

- 📋 Single/multiple choice modes
- 🤖 AI auto-generates voting topics
- 📊 Real-time bar chart statistics
- 👥 Real-time participant count display

#### ❓ Question Management

Student Q&A + Teacher approval integrated management (`/student-questions`):

- 🙋 **Student Questions**: Students initiate questions (supports anonymous)
- 🤖 **AI-Assisted Answering**: AI automatically generates suggested answers, teachers can modify before publishing
- 👨‍🏫 **Teacher Answering**: Teachers answer directly or approve student-provided answers
- ✅ **Approval Mechanism**: Teachers can mark student answers as "approved" or "not approved"
- 🔒 **Permission Control**: Only visible to students and teachers in the same class

> **Students can ask questions; Teachers can manage answers and approvals**

---

### ⚡ Quick-Answer Competition

Real-time multiplayer online quick-answer competition system:

- **Teacher Side**:
  - Create competition rooms (set time limit, question count, subject)
  - Question sources: from question bank / AI-generated
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

### 👥 Group Discussion (AI Tutor)

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

### 🖍️ Collaborative Whiteboard (AI Whiteboard Assistant)

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

### 🎯 Attendance & Roll Call Management

Integrated smart roll call + attendance statistics management:

- **🎲 Weighted Random Roll Call**: Each student has dynamic weight, weight decreases after being called,
  automatically resets after covering over 60% of students, ensuring fairness
- **✅ Roll Call Records**: Mark correct/incorrect, view history and statistics
- **📊 Roll Call Statistics**: Per-person statistics on times called and accuracy rate
- **📝 Attendance Records**: Automatically records each login time, IP, browser information
- **📅 History Tracking**: Complete login history records
- **👁️ Permission Control**: Teachers view only their own class, Admin can view all

> **Available to Admin and Teacher**

---

### ✅ Task Management (Homework System)

Teachers publish learning tasks, students submit AI dialogues as homework:

- **Teacher Side**:
  - Create tasks (name/description/deadline)
  - View student submission details
  - AI smart grading (3-dimension scoring: content completeness, logical clarity, expression accuracy)
  - Revoke submissions, end tasks
- **Student Side**:
  - View active tasks
  - Submit AI dialogue content as homework
  - View AI grading results

> **Available to all users, differentiated by role**

---

### 🎮 Knowledge Challenge

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

#### 📊 Learning Analytics

### 🔬 AI-Powered Learning Analytics

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

### 📊 AI Classroom Summary

AI comprehensively analyzes classroom interaction data:

- **🤖 Smart Analysis**: AI analyzes class quizzes, votes, questions, and other interaction data
- **📋 Summary Report**: Overall situation, participation analysis, knowledge point mastery, teaching suggestions
- **📄 Word Export**: Supports Word document export
- **📊 Class Filtering**: Filter analysis scope by grade/class

> **Available to Teacher and Admin**

---

### 📊 Progress Details

Comprehensive analysis of course progress and learning progress:

- **📖 Course Progress**: View chapter/knowledge point completion status of all students by course, expand for details
- **📊 Learning Progress**: View comprehensive student statistics by class (course progress/completion rate/accuracy rate/consecutive learning days), supports filtering individual students
- **🔍 Permission Control**: Teachers see only their own classes, Admin sees all

> **Available to Teacher and Admin**

---

### 📊 Activity Monitoring (Teaching Supervision)

Teachers view completion status of various teaching activities:

- **📋 Activity Types**: Exams, smart practice, quick-answer competitions, tasks, class quizzes, code exercises, group discussions, votes, course exercises
- **👥 Completion Status**: Completed / Not completed student lists
- **📊 Score Overview**: Brief scores and statistics
- **🔍 Multi-Dimensional Filtering**: Filter by activity name, grade, class
- **📥 Data Export**

> **Available to Teacher and Admin**

---

### 👁️ Resource View Tracking

Tracks student viewing of HTML and download resources:

- **📊 Statistics Overview**: Active student count, total views, viewed resource count
- **📋 Resource Details**: View count and viewing time per resource
- **👤 Student Details**: Resource viewing details per student
- **📚 Knowledge Point Binding**: View resource access by course knowledge point
- **🏆 Points Reward**: First viewing of shared resources automatically rewards 1 point

> **Available to Teacher and Admin**

---

### 📊 Data Export

Supports exporting various data to Excel/CSV:

- 📊 Exam score export
- 📊 Roll call record export
- 📊 Classroom interaction data export
- 📊 Activity monitoring data export
- 📊 Resource view tracking export

> **Available to Teacher and Admin**

---

### 🏆 Points Reward System (Auto Reward Engine)

Fully automated points incentive mechanism covering all classroom activities:

- **Activities Automatically Earn Points**:

  | Activity Type | Base Points | Grade Bonus |
  | --- | :---: | :---: |
  | Class Quiz | 2 | ✅ |
  | Quick Vote | 2 | ❌ |
  | Classroom Q&A | 2 | ✅ |
  | Exam | 2 | ✅ |
  | Targeted Practice | 2 | ✅ |
  | Group Discussion | 2 | ✅ |
  | Roll Call | 2 | ❌ |
  | AI Chat | 2 | ❌ |
  | Task | 2 | ✅ |
  | Learning Progress | 2 | ❌ |
  | Daily Login | 1 | ❌ |
  | Code Practice | 2 | ✅ |
  | Knowledge Challenge | 1 | ✅ |
  | Quick-Answer Competition | 2 | ✅ |
  | Course Exercise | 2 | ✅ |
  | Resource View | 1 | ❌ |
  | Daily Picks | 1 | ❌ |
  | Trending News | 1 | ❌ |

- **Grade Bonuses**: Excellent (≥90%) +15 / Good (≥75%) +10 / Pass (≥60%) +5
- **🏅 12-Level Title System**: Novice → Foundation Apprentice → Diligent Newcomer → Knowledge Hunter → Problem-Solving Pro
  → Logic Rising Star → Academic Pioneer → Class Scholar → Innovation Leader → Omnipotent Prodigy → Legendary Master → Supreme Sage
- **🎖️ Achievement Badges**: Rising Star, Full Score Master, Learning Star, Practice Pro, All-Rounder, AI Explorer, Discussion Star, Punctuality Master, Roll Call Master, Full Attendance Model, Challenge Series Badges, etc.
- **🏫 Class Ranking**: Total points ranking
- **📊 Points Rules Page**: Displays all points sources and rules

> **Admin/Teacher available; Student can view**

---

### 🏆 Classroom Points (Class Management)

Classroom points incentive system:

- ⭐ Each teacher independently manages points
- 📊 Points leaderboard (ranking within class)
- 👥 Student management (add/deduct points)
- 💾 Data persisted to database
- 📤 Supports import/export

> **Admin/Teacher available; Student can view**

---

### 🏆 Hall of Glory (Student Honor Showcase Wall)

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

### 👤 Student Growth Portfolio

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

#### ⚙️ System Management

### 👥 User Management

Complete account management system:

- **📝 Register Users**: Supports three roles: Admin, Teacher, Student
- **✏️ Update Information**: Modify username, class, grade, name, gender, role, teaching subjects
- **🔑 Change Password**: All users can change their own password; Admin can reset others' passwords
- **🗑️ Delete Users**: Single or batch delete
- **📤 CSV Import**: Batch import users
- **🔍 Filter & Search**: Filter by role/grade/class, search by username/name
- **🏫 Teacher Assignment**: Set teacher's teaching grades, classes, and subjects
- **📊 Batch Grade Promotion/Demotion**: One-click preview and execute, intelligently sync points and roll call data
- **🔒 Security Settings**: Security questions (forgot password self-service recovery)
- **🔐 Single Sign-On**: Token version control, remote login kickout

> **Admin and Teacher available; Student can only change password**

---

### 📢 System Announcements

Publish and manage system announcements:

- **📝 Publish Announcement**: Title, content, priority (Normal/Important/Emergency)
- **📌 Pin Function**: Pin important announcements to top
- **👥 Visibility Scope**: Limited by role (Student/Teacher/Admin), grade, class
- **📋 Announcement List**: Paginated display, sorted by priority
- **✏️ Edit/Delete**: Manage published announcements

> **All users can view; Admin and Teacher can publish**

---

### ⚙️ System Configuration

Centralized management of all system configuration parameters:

- **🏷️ Brand Info**: Platform version name, organization name
- **🔑 API Keys**: DashScope API Key
- **🤖 Model Configuration**: APPID, API address, default chat model, long-text model, vision model, multimodal toggle
- **💬 AI Chat Settings**: Chat permission roles
- **⚙️ System Limits**: File size limit, token validity, online timeout, rate limits
- **📚 Course Settings**: Course name list, question types
- **🔔 Notifications**: Enabled notification types
- **📁 File Type Whitelist**: Image/document extensions
- **🎨 Image Generation**: Image generation toggle, model, size
- **⚡ Knowledge Challenge**: Question mode (question bank/AI)

> **Admin only**

---

### 🎯 Skill Management

Modular AI Skill Document System — each skill is defined via YAML + Markdown, automatically injected into AI calls by scene:

- **🧩 20 Pre-installed Skills**: 8 core + 12 domain-specific
- **🎯 Scene-Aware Injection**: controls which scenes each skill applies to
- **⚡ Three-Stage Quality Enhancement**: Deep Analysis → Structured Output → Self-Review
- **📋 Visual Management**: Search, filter by type, pagination, toggle all on/off
- **🔍 Detail Preview**: View raw skill document, version, tags, priority
- **🛡️ Safe Degradation**: Skills silently skip on error, zero impact on existing features

> **Admin only**

---

### 🔔 Notification Center

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

### 🎨 AI Self-Portrait

Personalized AI portrait generated based on Tongyi Wanxiang model:

- **🤖 AI Image Generation**: Generates exclusive portraits based on user platform data (points, title, learning/teaching data)
- **🎭 15 Creative Styles**:
  🔮 Magic Academy | 💻 Cyber Scholar | 🖌️ Chinese Ink | 🚀 Space Explorer | 💥 Action Comics
  🧚 Fairy Tale Elf | ⚙️ Steampunk | 🎮 Pixel World | 🎭 Dunhuang Flying Apsaras | 🌌 Aurora Dreamscape
  🦸 Superhero | ⚔️ Temple Knight | 🦋 Cyber Elf | 🐚 Ocean Explorer | ⏳ Time Traveler
- **📝 Creative Messages**: Large model automatically generates stylized messages based on user data (martial arts, interstellar, classical, etc.)
- **👤 Role-Aware**: Automatically adjusts portrait identity and message tone based on Student/Teacher/Admin
- **♀️♂️ Gender Accuracy**: Reads user gender information to ensure correct portrait gender
- **🖼️ Personal Gallery**: Historical portraits displayed chronologically
- **🌐 Sharing Gallery**:
  - School-wide gallery / Class gallery / Popular recommendations
  - Like interaction
  - Three privacy scopes: Public / Class-visible / Private
- **⏰ Generation Limit**: Once per week

> **Available to all logged-in users**

---

### 🔄 Online Upgrade System (Version Management)

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

### ❓ About System

| Feature | Description |
| --- | --- |
| ❓ **About System** | View documentation |

---

### 🛠️ Other System Services

| Feature | Description |
| --- | --- |
| 🔑 **Change Password** | All users can change their own password |
| 🔐 **Forgot Password** | Self-service password recovery via security questions |
| 🗑️ **Temp File Cleanup** | Automatically cleans temporary upload files older than 24 hours |

## 📦 Changelog

### v8.0.0 (2026-09-05)

- 🔒 **Site-wide Authorization Hardening**: 16 rounds of feature-by-feature audit; anonymous reads and cross-teacher writes closed
- 🎯 **Roll Call & Class Interaction**: ownership pinned to the login identity, publish scope limited to assigned classes, class analytics fixed (score/roll-call dimensions were permanently 0)
- ⚙️ **System Config & Skill Management**: atomic writes with backup fallback, value validation, masked secret echo; skill detail/write endpoints restricted to admins
- 📊 **Export · Announcements · Dashboard · Resources**: broken pagination, publish scope, token leaked via URL, duplicated activity, stale rename bindings all fixed
- 📝 **Frontend i18n**: untranslated keys completed in both languages for security setup, question bank editor, paper composer, announcements, interaction and whiteboard
- ⚠️ **Breaking Changes**: roll-call write endpoints and history now require login within assigned scope; quizzes/polls may only target the teacher's own assignments; config API masks secrets

---

### v7.6.0 (2026-07-08)

- 🎯 **Skill Document System**: 20 modular AI skills, auto-injected by scene into 25 API routes
- ⚡ **Three-Stage Quality Enhancement**: Deep Analysis → Structured Output → Self-Review, verified by A/B testing
- 🧩 **8 Core Skills + 12 Domain Skills**: Covering chat, exams, quizzes, whiteboard, code review and all scenarios
- 📋 **Skill Management Page**: Visual list, toggle all on/off, detail preview, paginated search
- 🔌 **Unified Injection**: `apply_skills(prompt, scene)` one-liner across all routers

---

### v7.5.0 (2026-07-07)

- 🌐 **i18n Multi-Language Support**: One-click switch between Chinese and English across all pages
- 🔤 **react-i18next Integration**: 13 namespaces, ~2000+ translation keys
- 🔄 **Language Switching Optimized**: Default Chinese, localStorage persistence, fixed sync issues

---

### v7.4.0 (2026-07-06)

- 🏆 **Hall of Glory**: Student honor showcase wall with integrated points/titles/badges display, 10 gradient themes, like interaction
- 📐 **Site-wide UI Unification**: 24px margin standard, Card container standardization across all ~60 pages
- 🐛 **Fixes**: Q&A page layout adaptation, Card margin consistency across pages

---

### v7.3.0 ~ v6.0.0

- ⭐ **Daily Picks**: AI fun knowledge card pool, on-demand replenishment with zero waste, 7-day deduplication window
- 📰 **Trending News**: RSS aggregation of 5 major sources, AI on-demand summaries + subject association + daily briefing
- ⚡ **Anti-Waste Architecture**: Zero AI/Zero fetching when no one is using, on-demand triggering
- 🏆 **6 New Badges**: Knowledge Explorer, Encyclopedia Expert, Collector, Current Affairs Rookie, Current Affairs Pro, Know-It-All
- 🔍 **Comprehensive Security Audit**: 12 functional module audits, fixes applied
- 🔧 **Architecture & Quality Optimization**: Async refactoring, N+1 optimization, JSON unification, normalization
- 🎯 **Activity Target Scope Control**: 6 activity types support precise target scope specification
- 🎨 **AI Self-Portrait**: 15 creative styles, sharing gallery with like interaction
- 🤖 **AI Companion & Teaching Assistant**: Companion with 3 personalities, proactive push; Assistant with smart lesson planning, auto exam generation
- 🖍️ **Collaborative Whiteboard**: Presentation/Interactive/Self-Study modes, AI teaching assistance
- 📝 **Smart Practice & Course Exercises**: AI-directed questioning, auto-grading, points rewards
- 🎮 **Challenge Management Upgrade**: AI batch question generation, online incremental upgrade
- 🖼️ **Multimodal Dialogue**: Simultaneous image + text input
- 💻 **AI-Generated HTML Resources**: 5 types, question bank + AI mixed questioning
- 📐 **All-Grade All-Subject Refactoring**: Subject hardcoding removed, multi-subject teacher assignment
- 🎭 **Multi-Theme Appearance System**: 5 beautiful themes with one-click switching
- 📋 **User Management Upgrade**: Batch import, batch grade promotion, single sign-on
- 📊 **Learning Analytics & Growth Portfolio**: Exam analysis, class reports, five-dimension statistics
- 📄 **Smart Paper Generation & Word Export**: Step-by-step wizard, LaTeX formula rendering

---

## 📦 Deployment Guide

### Method 1: Download Source Package (Recommended for Beginners)

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

### Method 2: Git Clone Deployment (Recommended, Supports Online Upgrade)

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

## 🚀 Quick Start

### Environment Requirements

- Python 3.9+

### 1️⃣ Start Backend Service

```bash
# Method 1: Direct start
cd D:\SmartKBS
python backend/main.py

# Method 2: Start with Uvicorn
python -m uvicorn backend.main:app --host 0.0.0.0 --port 8086 --reload
```

The backend service runs by default at `http://localhost:8086`, automatically serving frontend static files.

### 2️⃣ Start Frontend Dev Server (Only needed when developing frontend)

```bash
cd frontend
npm install
npm run dev
```

Frontend dev mode runs by default at `http://localhost:5173`

### 3️⃣ Default Admin Login

| Username | Password |
| --- | --- |
| root | root |

### 4️⃣ Configure AI Service

Set the DashScope API Key in the "System Configuration" page.

---

## 📁 Project Structure

```text
SmartKBS/
├── backend/                    # FastAPI Backend
│   ├── main.py                 # Entry file (route mounting, static file serving)
│   ├── config.py               # Global configuration constants
│   ├── database.py             # Database connection management (smartkb.db)
│   ├── question_db.py          # Question bank database (questions.db)
│   ├── auth.py                 # JWT authentication + bcrypt password hashing + SSO
│   ├── middleware.py           # Authentication middleware
│   ├── logger.py               # Unified logging configuration
│   ├── rag.py                  # RAG retrieval-augmented generation
│   ├── paper_generator.py      # Word exam paper generation engine (python-docx)
│   ├── reward_engine.py        # Points reward engine
│   ├── ai_task_manager.py      # AI async task manager
│   ├── permission_service.py   # Unified grade-class permission service
│   ├── companion_memory.py     # AI companion memory engine
│   ├── companion_profile.py    # AI companion configuration management
│   ├── companion_push.py       # AI companion proactive push engine
│   ├── title_system.py         # 12-level title + achievement badge system
│   ├── score_utils.py          # Points utility functions
│   ├── subject_config.py       # Subject configuration
│   ├── code_grader.py          # Code auto-grading engine
│   ├── code_runner.py          # Code sandbox execution engine
│   ├── whiteboard_ws.py        # Collaborative whiteboard WebSocket manager
│   ├── ws_manager.py           # WebSocket connection manager (discussion)
│   ├── downloads_api.py        # File download API
│   ├── system_config.json      # Runtime configuration
│   ├── api/                    # API route modules
│   │   ├── ai_service.py       # Unified AI invocation service (dual mode)
│   │   ├── image_gen_service.py# Tongyi Wanxiang image generation
│   │   └── ... (route files)
│   ├── prompts/                # AI Prompt templates
│   │   ├── chat.py, exam.py, paper.py, quiz.py
│   │   ├── companion.py, portrait.py, quest.py
│   │   ├── practice.py, recommend.py, report.py
│   │   ├── whiteboard_ai.py, html_generator.py
│   │   └── ...
│   └── migrations/             # Database migration scripts
├── frontend/                   # React + Vite + TypeScript Frontend
│   ├── src/
│   │   ├── api/                # API interface modules
│   │   ├── components/         # Shared components
│   │   ├── pages/              # Page components
│   │   ├── stores/             # Zustand state management
│   │   ├── types/              # TypeScript type definitions
│   │   ├── hooks/              # Custom hooks
│   │   └── styles/             # Theme styles
│   └── dist/                   # Pre-built build output
├── root/                       # Admin data directory
│   ├── html/                   # Teaching resources
│   └── ChatHistory/            # Chat history
├── stu/                        # Student data directory
├── question_media/             # Question image files
├── temp_uploads/               # Temporary upload files (auto-cleaned)
├── LogFiles/                   # Log files
├── package.json                # Project configuration
├── requirements.txt            # Python dependencies
└── README.md
```

---

## 💾 Data Storage

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
| Self-portraits | `<user_dir>/portraits/` |
| Whiteboard snapshots | Database `whiteboard_pages` table |

---

## 👥 Permissions Overview

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
| Task Management | ✅ Submit | ✅ Manage | ✅ Manage |
| To-Do Items | ✅ | ❌ | ❌ |
| Resource Center (Browse Shared) | ✅ | ✅ | ✅ |
| Resource Management | ❌ | ✅ | ✅ |
| Resource Category Navigation | ✅ | ✅ | ✅ |
| File Center | ✅ Shared Files | ✅ | ✅ |
| Classroom Points | ✅ View | ✅ Own Class | ✅ All |
| Points Reward System | ✅ View | ✅ Own Class | ✅ All |
| Roll Call Management | ❌ | ✅ Own Class | ✅ All |
| Attendance Statistics | ❌ | ✅ Own Class | ✅ All |
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
| AI Self-Portrait | ✅ | ✅ | ✅ |
| Collaborative Whiteboard | ✅ Participate | ✅ Create | ✅ Create |
| Activity Monitoring | ❌ | ✅ | ✅ |
| Resource View Tracking | ❌ | ✅ | ✅ |
| AI Resource Recommendations | ❌ | ✅ | ✅ |
| AI-Generated HTML Resources | ❌ | ✅ | ✅ |
| Data Export | ❌ | ✅ | ✅ |
| User Management | Change Password Only | ✅ Partial | ✅ Full |
| System Announcements | ✅ View | ✅ Publish | ✅ Publish |
| Notification Center | ✅ | ✅ | ✅ |
| System Configuration | ❌ | ❌ | ✅ |
| Online Upgrade (Version Management) | ❌ | ❌ | ✅ |
| Multi-Theme System | ✅ | ✅ | ✅ |
| About System | ✅ | ✅ | ✅ |

---

## 🔧 Tech Stack

| Layer | Technology |
| --- | --- |
| **Backend Framework** | Python 3.11+, FastAPI, Uvicorn |
| **Frontend Framework** | React 19, TypeScript, Vite 6 |
| **UI Component Library** | Ant Design 6, Ant Design Charts |
| **State Management** | Zustand |
| **Routing** | React Router 7 |
| **Database** | SQLite (dual-database architecture) |
| **Authentication** | JWT (bcrypt + PyJWT), Token Version SSO |
| **AI Models** | Tongyi Qianwen DashScope (Qwen), DeepSeek |
| **AI Invocation Modes** | Bailian Agent Application / Direct Model Invocation (dual mode) |
| **Image Generation** | Tongyi Wanxiang (wanx2.1/wan2.2) |
| **Streaming** | Server-Sent Events (SSE) |
| **Real-Time Communication** | WebSocket (Whiteboard / Discussion / Quick-Answer) |
| **Document Export** | python-docx (Word), openpyxl (Excel) |
| **Formula Rendering** | matplotlib (LaTeX → image) |
| **Whiteboard Engine** | TLDraw |
| **Security Sandbox** | AST static analysis + subprocess isolation |

---

## 📄 License

This project is open-sourced under the **GNU Affero General Public License v3.0 (AGPL-3.0)**.

Copyright © 2026 youufis

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published
by the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

---

## ❓ FAQ

**Q: What if I forget my password?**
A: If you have set security questions, click "Forgot Password" on the login page to recover it yourself. Otherwise, contact an admin to reset it in "User Management".

**Q: AI chat is not responding?**
A: Check whether a valid DashScope API Key has been filled in "System Configuration". If filled, check whether the API Key balance is sufficient.

**Q: File upload failed?**
A: Max document size is 10MB, max image size is 5MB. Check whether the file format is in the whitelist.

**Q: Can't use AI Companion/Assistant?**
A: Companion mode is only available to students; Assistant mode is only available to teachers/admins. Please verify your login role is correct.

**Q: Can't submit an exam?**
A: Check whether the current time is within the exam's valid time range and whether you have used up your allowed attempts.

**Q: Classroom points not increasing?**
A: Confirm you participated in an activity type that supports points. Points are automatically awarded after activity completion. Grade bonuses require corresponding score percentages.

**Q: How to upgrade the system?**
A: 1. After admin login, go to "System Configuration → Version Management", click "Check for Updates" and follow the prompts (Git deployment only).
   2. Download the latest source code ZIP, extract and overwrite the original directory (preserve `backend/system_config.json` and database files), then restart the service.

---

## 📬 About

**SmartKBS** — AI-Powered Smart Teaching Platform for All Grades and Subjects

- 👨‍💻 **Author:** UNET
- 📧 **Contact:** [youufis@sina.com](mailto:youufis@sina.com)
- 💬 **WeChat:** UNET-WX
