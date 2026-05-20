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
const RESOURCE_TYPES = new Set(['notes', 'past_paper', 'scheme', 'other']);

function cleanText(value) {
  return String(value || '').trim();
}

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

router.get('/resources', (req, res) => {
  const db = getDB();
  const where = ['published=1'];
  const params = [];
  const type = cleanText(req.query.type).toLowerCase();
  if (type) {
    if (!RESOURCE_TYPES.has(type)) return res.status(400).json({ success:false, message:'Invalid resource type' });
    where.push('type=?');
    params.push(type);
  }
  const grade = cleanText(req.query.grade);
  if (grade) {
    where.push('LOWER(grade)=LOWER(?)');
    params.push(grade);
  }
  const subject = cleanText(req.query.subject);
  if (subject) {
    where.push('LOWER(subject)=LOWER(?)');
    params.push(subject);
  }
  const q = cleanText(req.query.q);
  if (q) {
    where.push('title LIKE ?');
    params.push(`%${q}%`);
  }
  const resources = db.prepare(`
    SELECT id, type, title, grade, subject, year, updated_at
    FROM resources
    WHERE ${where.join(' AND ')}
    ORDER BY datetime(updated_at) DESC, id DESC
    LIMIT 200
  `).all(...params);
  res.json({ success:true, data:{ resources } });
});

router.get('/resources/:id', (req, res) => {
  const db = getDB();
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ success:false, message:'Invalid resource' });
  const resource = db.prepare(`
    SELECT id, type, title, grade, subject, year, body_html, file_path, views, created_at, updated_at
    FROM resources
    WHERE id=? AND published=1
  `).get(id);
  if (!resource) return res.status(404).json({ success:false, message:'Resource not found' });
  db.prepare('UPDATE resources SET views=views+1 WHERE id=?').run(id);
  res.json({ success:true, data:{ ...resource, views:Number(resource.views || 0) + 1 } });
});

module.exports = router;
