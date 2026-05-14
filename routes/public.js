const express = require('express');
const { getDB } = require('../database');
const router = express.Router();

const PUBLIC_SCHOOL_FIELDS = [
  'school_name',
  'school_motto',
  'school_logo',
  'school_address',
  'school_phone',
  'school_email'
];

function defaultSchoolSettings() {
  return {
    school_name: 'JOYLAND SCHOOLS',
    school_motto: 'Education Is Treasure',
    school_address: 'P.O. Box 123',
    school_phone: '0700 000 000',
    school_email: 'info@joylandschools.ac.ke',
    school_logo: '/uploads/school/logo.jpg'
  };
}

function getSchoolSettings(db) {
  const settings = defaultSchoolSettings();
  db.prepare('SELECT key, value FROM school_settings').all().forEach((row) => {
    settings[row.key] = row.value || '';
  });
  return settings;
}

function publicSchoolInfo(settings) {
  return PUBLIC_SCHOOL_FIELDS.reduce((data, field) => {
    data[field] = settings[field] || '';
    return data;
  }, {});
}

router.get('/school-info', (req, res) => {
  const db = getDB();
  res.json({ success: true, data: publicSchoolInfo(getSchoolSettings(db)) });
});

module.exports = router;
