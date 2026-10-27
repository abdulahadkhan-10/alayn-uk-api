import { Router } from 'express';
import { DashboardController } from './dashboard.controller';
import { authMiddleware } from '../../middleware/auth.middleware';
import { businessMiddleware } from '../../middleware/business.middleware';

const router = Router();
const controller = new DashboardController();

router.use(authMiddleware);

router.get('/kpi', businessMiddleware, controller.getKpi);
router.get('/sales-velocity', businessMiddleware, controller.getSalesVelocity);
router.get('/channel-distribution', businessMiddleware, controller.getChannelDistribution);
router.get('/top-selling-items', businessMiddleware, controller.getTopSellingItems);
router.get('/sales-forecast', businessMiddleware, controller.getSalesForecast);
router.get('/attention', businessMiddleware, controller.getAttention);
router.get('/staff-today', businessMiddleware, controller.getStaffToday);
router.get('/slow-movers', businessMiddleware, controller.getSlowMovers);
router.get('/today-pace', businessMiddleware, controller.getTodayPace);
router.get('/staffing-week', businessMiddleware, controller.getStaffingWeek);
router.get('/inventory-forecast', businessMiddleware, controller.getInventoryForecast);

export default router;
