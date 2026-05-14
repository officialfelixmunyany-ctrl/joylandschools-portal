const SCHOOL_TIME_ZONE = process.env.SCHOOL_TIME_ZONE || 'Africa/Nairobi';

function todayInSchoolTime(date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: SCHOOL_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(date).reduce((map, part) => {
      map[part.type] = part.value;
      return map;
    }, {});
    return `${parts.year}-${parts.month}-${parts.day}`;
  } catch {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
}

module.exports = { SCHOOL_TIME_ZONE, todayInSchoolTime };
