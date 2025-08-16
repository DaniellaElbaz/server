const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/parentCalendarController');

// Events
router.get('/events',     ctrl.listEvents);
router.post('/events',    ctrl.createEvent);
router.patch('/events/:id', ctrl.updateEvent);
router.delete('/events/:id', ctrl.deleteEvent);

// Categories
router.get('/categories', ctrl.listCategories);
router.post('/categories', ctrl.createCategory);

module.exports = router;
