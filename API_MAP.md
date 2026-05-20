# API Map

Backend entrypoint: `server.js`

Route mounts:

- `/api`: public routes from `routes/public.js`
- `/api/auth`: auth routes from `routes/auth.js`
- `/api/admin`: admin routes from `routes/admin.js`
- `/api/teacher`: teacher routes from `routes/teacher.js`
- `/api/learner`: learner routes from `routes/learner.js`
- `/api/parent`: parent routes from `routes/parent.js`
- `/api/notifications`: notification routes from `routes/notifications.js`

## API Rules

- Standard response: `{ success, data, message? }`.
- Protected identity must come from `req.session.user.id`.
- Role routes must never trust role IDs passed from the client.
- Teacher class access must be checked against class teacher or subject assignment depending on endpoint.
- Parent learner access must be checked against `parent_learner_links`.
- Learner routes must only return the logged-in learner's own data.

## Public API

- `GET /api/school-info`
- `GET /api/resources`
- `GET /api/resources/:id`

## Auth API

- `POST /api/auth/login`
- `POST /api/auth/temp-login`
- `POST /api/auth/logout`
- `GET /api/auth/me`

## Admin API Groups

File: `routes/admin.js`

- Calendar and holidays: `/calendar/events`, `/terms/:id/holidays`, `/school-day`
- School settings and assets: `/school-settings`, `/school-assets`
- Resources library: `/resources`, `/resources/:id/file`
- Roles and permissions: `/roles`, `/permissions`
- Integrations and backups: `/integrations`, `/backups`, `/billing/sms-balance`
- Comments and signatures: `/comment-bank`, `/comments`, `/signature/:role`, `/signatures`
- Dashboard and period metadata: `/stats`, `/current-period`
- Timetable: `/timetable/*`, `/bookings`
- People: `/learners`, `/teachers`, `/parents`
- Academics: `/classes`, `/subjects`, `/class-subjects`, `/sessions`, `/terms`
- Attendance: `/attendance`, `/attendance/bulk`, `/attendance/summary`
- Marks and assessments: `/marks`, `/marks/publish`, `/assessment-components`, `/marks/broadsheet`, `/marks/analysis`
- Analysis: `/cohort-tracker`, `/equity-splits`
- Reports: `/templates`, `/report-card`
- Skills: `/skills`, `/skills/ratings`, `/skills/progress`

Risk: `routes/admin.js` is over 3,400 lines. It should be split by domain.

## Teacher API Groups

File: `routes/teacher.js`

- Profile/session: `/me`, `/profile`, `/change-password`
- Dashboard/home: `/dashboard`, `/home`, `/teaching-analytics`, `/teaching`
- Timetable/bookings: `/timetable`, `/timetable/free-slots`, `/bookings`
- Classes/roster: `/classes/:id/learners`
- Attendance: `/school-day`, `/attendance/overview`, `/attendance`, `/attendance/history`, `/attendance/summary`
- Marks: `/assessment-components`, `/marks`
- Skills: `/skills/config`, `/skills`
- Comments: `/comments`, `/comments/suggestions`
- Reports: `/report-readiness`, `/report-card`, `/report-cards`, `/broadsheet`
- Notifications: `/notifications`

Risk: `routes/teacher.js` is over 2,000 lines and includes analytics, reports, marks, skills, comments, and attendance in one module.

## Learner API Groups

File: `routes/learner.js`

- Profile: `/me`, `/photos`, `/dashboard`
- Timetable: `/timetable`
- Academic data: `/summary`, `/marks`, `/attendance`, `/skills`, `/comments`
- Games: `/games/score`, `/games/scores`
- Notifications: `/notifications`
- Account: `/change-password`

## Parent API Groups

File: `routes/parent.js`

- Profile: `/me`, `/children`
- Timetable: `/timetable`
- Child scoped views: `/children/:learnerId/summary`, `/marks`, `/attendance`, `/skills`, `/comments`
- Notifications: `/notifications`

## Notifications API

File: `routes/notifications.js`

- Admin broadcast/history/stats/recipients/delete/send
- Device token registration
- User inbox, unread count, mark read

## Modernization Priorities

1. Split route files by domain.
2. Add shared authorization helpers.
3. Add shared validation helpers.
4. Add a route smoke-test script.
5. Add API documentation examples for each role.
6. Add audit logging for write actions.
7. Move secrets and deployment-specific URLs out of source.
