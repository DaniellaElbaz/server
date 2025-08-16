const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/parentCalendarController');

// Events
router.get('/events',     ctrl.listEvents);
router.post('/events',    ctrl.createEvent);
router.get('/events/:id',    ctrl.getEventById);
router.patch('/events/:id', ctrl.updateEvent);
router.delete('/events/:id', ctrl.deleteEvent);

// Categories
router.get('/categories', ctrl.listCategories);
router.post('/categories', ctrl.createCategory);

module.exports = router;
