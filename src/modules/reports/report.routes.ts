import { Router } from 'express';
import { ReportController } from './report.controller';
import { authMiddleware } from '../../middleware/auth.middleware';
import { businessMiddleware } from '../../middleware/business.middleware';
import { authorize } from '../../middleware/role.middleware';

const router = Router();
const controller = new ReportController();

router.use(authMiddleware, businessMiddleware, authorize('BUSINESS_OWNER', 'MANAGER', 'SUPER_ADMIN'));

// Weekly / monthly report emails: owners only
router.get('/schedule', authorize('BUSINESS_OWNER'), controller.getSchedule);
router.put('/schedule', authorize('BUSINESS_OWNER'), controller.saveSchedule);
router.post('/schedule/test', authorize('BUSINESS_OWNER'), controller.sendTestSchedule);

router.get('/', controller.getReport);
router.get('/export', controller.exportReport);
router.get('/options', controller.getOptions);
// Items taken off bills (by staff, managers or owners): who, what, worth and why
router.get('/removed-items', controller.getRemovedItems);

export default router;
