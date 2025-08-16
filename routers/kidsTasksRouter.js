const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/kidsTasksController');

// משימות של ילד לתאריך (ברירת מחדל: היום)
router.get('/tasks', ctrl.listChildTasksForDay);

// הילד לוחץ "סיימתי"
router.post('/tasks/mark-done', ctrl.childMarkDone);

// ניקוד יומי למסך (פינה ימנית למעלה)
router.get('/score/daily', ctrl.childDailyScore);

// טבלת מובילים לשבוע (לפודיום)
router.get('/score/leaderboard', ctrl.familyLeaderboardThisWeek);

module.exports = router;
