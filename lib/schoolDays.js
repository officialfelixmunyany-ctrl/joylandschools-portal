const DEFAULT_WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function validDateStr(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return text;
}

function parseWeekdays(value) {
  try {
    const days = JSON.parse(value || '[]');
    return Array.isArray(days) && days.length ? days : DEFAULT_WEEKDAYS;
  } catch {
    return DEFAULT_WEEKDAYS;
  }
}

function dateDayName(date) {
  const [y, m, d] = String(date).split('-').map(Number);
  return DAY_NAMES[new Date(y, m - 1, d).getDay()];
}

function calendarHolidayForDate(db, date, termId = null) {
  try {
    return db.prepare(`
      SELECT id, title AS name, date AS start_date, COALESCE(end_date, date) AS end_date, term_id
      FROM school_events
      WHERE type='hol'
        AND date(date) <= date(?)
        AND date(COALESCE(end_date, date)) >= date(?)
        AND (term_id IS NULL OR ? IS NULL OR term_id=?)
      ORDER BY CASE WHEN term_id IS NULL THEN 1 ELSE 0 END, date(date) DESC
      LIMIT 1
    `).get(date, date, termId, termId);
  } catch {
    return null;
  }
}

function resolveSchoolDay(db, dateValue) {
  const date = validDateStr(dateValue);
  if (!date) {
    return {
      date: String(dateValue || ''),
      is_school_day: false,
      reason: 'invalid_date',
      message: 'Invalid date'
    };
  }

  const calendarHoliday = calendarHolidayForDate(db, date);
  const term = db.prepare(`
    SELECT t.id, t.term_number, t.term_name, t.start_date, t.end_date, t.weekdays,
           s.name AS session_name, s.year AS session_year
    FROM terms t
    JOIN academic_sessions s ON s.id=t.session_id
    WHERE date(t.start_date) <= date(?) AND date(t.end_date) >= date(?)
    ORDER BY date(t.start_date) DESC
    LIMIT 1
  `).get(date, date);

  if (!term) {
    if (calendarHoliday) {
      return {
        date,
        is_school_day: false,
        reason: 'holiday',
        message: `${calendarHoliday.name} is a school break/holiday`,
        holiday: calendarHoliday
      };
    }
    return {
      date,
      is_school_day: false,
      reason: 'outside_term',
      message: 'This date is outside the school term calendar'
    };
  }

  const holiday = db.prepare(`
    SELECT id, name, start_date, end_date
    FROM holidays
    WHERE term_id=?
      AND date(start_date) <= date(?)
      AND date(end_date) >= date(?)
    ORDER BY date(start_date) DESC
      LIMIT 1
  `).get(term.id, date, date);
  const eventHoliday = calendarHolidayForDate(db, date, term.id);

  const weekdays = parseWeekdays(term.weekdays);
  const dayName = dateDayName(date);
  const isWeekday = weekdays.includes(dayName);
  const termData = {
    id: term.id,
    term_number: term.term_number,
    term_name: term.term_name,
    start_date: term.start_date,
    end_date: term.end_date,
    session_name: term.session_name,
    session_year: term.session_year
  };

  if (holiday) {
    return {
      date,
      is_school_day: false,
      reason: 'holiday',
      message: `${holiday.name} is a school break/holiday`,
      term: termData,
      holiday,
      weekday: dayName,
      allowed_weekdays: weekdays
    };
  }

  if (eventHoliday) {
    return {
      date,
      is_school_day: false,
      reason: 'holiday',
      message: `${eventHoliday.name} is a school break/holiday`,
      term: termData,
      holiday: eventHoliday,
      weekday: dayName,
      allowed_weekdays: weekdays
    };
  }

  if (!isWeekday) {
    return {
      date,
      is_school_day: false,
      reason: 'non_school_day',
      message: `${dayName} is not a school day for this term`,
      term: termData,
      weekday: dayName,
      allowed_weekdays: weekdays
    };
  }

  return {
    date,
    is_school_day: true,
    reason: 'school_day',
    message: 'School day',
    term: termData,
    weekday: dayName,
    allowed_weekdays: weekdays
  };
}

module.exports = { resolveSchoolDay, validDateStr };
