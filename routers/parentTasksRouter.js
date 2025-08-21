const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/parentTasksController');

// רשימת פריטים לאישור (הילד סימן "סיימתי" = status=1)
router.get('/review', ctrl.listForReview);

// אישור משימה (מעניק נקודה)
router.post('/approve', ctrl.approveOne);

// דחייה / ביטול
router.post('/reject', ctrl.rejectOne);

module.exports = router;

