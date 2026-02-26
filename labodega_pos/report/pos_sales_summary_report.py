# -*- coding: utf-8 -*-
from datetime import datetime, timedelta
import pytz
from odoo import api, fields, models, _


class PosSalesSummaryReport(models.AbstractModel):
    _name = 'report.labodega_pos.pos_sales_summary'
    _description = 'POS Sales Summary Report'

    def _get_user_timezone(self):
        """Get user timezone"""
        return pytz.timezone(self.env.context.get('tz') or self.env.user.tz or 'UTC')

    def _get_today_range(self):
        """Get today's date range in UTC"""
        user_tz = self._get_user_timezone()
        today = datetime.now(user_tz).replace(hour=0, minute=0, second=0, microsecond=0)
        tomorrow = today + timedelta(days=1)

        # Convert to UTC for database queries
        date_start = today.astimezone(pytz.UTC).replace(tzinfo=None)
        date_stop = tomorrow.astimezone(pytz.UTC).replace(tzinfo=None)

        return date_start, date_stop

    def _get_month_range(self):
        """Get current month's date range in UTC"""
        user_tz = self._get_user_timezone()
        today = datetime.now(user_tz)
        month_start = today.replace(day=1, hour=0, minute=0, second=0, microsecond=0)

        # Get first day of next month
        if today.month == 12:
            month_end = today.replace(year=today.year + 1, month=1, day=1, hour=0, minute=0, second=0, microsecond=0)
        else:
            month_end = today.replace(month=today.month + 1, day=1, hour=0, minute=0, second=0, microsecond=0)

        # Convert to UTC
        date_start = month_start.astimezone(pytz.UTC).replace(tzinfo=None)
        date_stop = month_end.astimezone(pytz.UTC).replace(tzinfo=None)

        return date_start, date_stop

    def _get_year_range(self):
        """Get current year's date range in UTC"""
        user_tz = self._get_user_timezone()
        today = datetime.now(user_tz)
        year_start = today.replace(month=1, day=1, hour=0, minute=0, second=0, microsecond=0)
        year_end = today.replace(year=today.year + 1, month=1, day=1, hour=0, minute=0, second=0, microsecond=0)

        # Convert to UTC
        date_start = year_start.astimezone(pytz.UTC).replace(tzinfo=None)
        date_stop = year_end.astimezone(pytz.UTC).replace(tzinfo=None)

        return date_start, date_stop

    def _get_top_products(self, date_start, date_stop, limit=20):
        """Get top selling products for the given date range"""
        self.env.cr.execute("""
            SELECT 
                pp.id as product_id,
                pt.name as product_name,
                SUM(pol.qty) as total_qty,
                SUM(pol.price_subtotal_incl) as total_amount
            FROM pos_order_line pol
            JOIN pos_order po ON po.id = pol.order_id
            JOIN product_product pp ON pp.id = pol.product_id
            JOIN product_template pt ON pt.id = pp.product_tmpl_id
            WHERE po.state IN ('paid', 'done', 'invoiced')
                AND po.date_order >= %s
                AND po.date_order < %s
                AND pol.qty > 0
            GROUP BY pp.id, pt.name
            ORDER BY total_amount DESC
            LIMIT %s
        """, (date_start, date_stop, limit))

        results = self.env.cr.dictfetchall()

        # Handle JSONB name field
        for r in results:
            if isinstance(r.get('product_name'), dict):
                r['product_name'] = r['product_name'].get('en_US') or list(r['product_name'].values())[0] if r['product_name'] else 'Unknown'

        return results

    def _get_sessions_today(self):
        """Get today's sessions with sales data"""
        date_start, date_stop = self._get_today_range()

        # Use sudo() to bypass POS config user restrictions for reporting purposes
        # The report needs to show all sessions regardless of terminal access
        sessions = self.env['pos.session'].sudo().search([
            ('start_at', '>=', date_start),
            ('start_at', '<', date_stop),
        ], order='start_at desc')

        session_data = []
        for session in sessions:
            orders = self.env['pos.order'].sudo().search([
                ('session_id', '=', session.id),
                ('state', 'in', ['paid', 'done', 'invoiced'])
            ])

            total_sales = sum(orders.mapped('amount_total'))
            total_orders = len(orders)

            # Get payment breakdown
            payments = {}
            for order in orders:
                for payment in order.payment_ids:
                    method_name = payment.payment_method_id.name
                    payments[method_name] = payments.get(method_name, 0) + payment.amount

            session_data.append({
                'id': session.id,
                'name': session.name,
                'config_name': session.config_id.name,
                'user': session.user_id.name,
                'state': session.state,
                'start_at': session.start_at,
                'stop_at': session.stop_at,
                'total_sales': total_sales,
                'total_orders': total_orders,
                'payments': payments,
            })

        return session_data

    def _get_today_summary(self):
        """Get today's sales summary"""
        date_start, date_stop = self._get_today_range()

        # Use sudo() to bypass POS config user restrictions for reporting purposes
        orders = self.env['pos.order'].sudo().search([
            ('date_order', '>=', date_start),
            ('date_order', '<', date_stop),
            ('state', 'in', ['paid', 'done', 'invoiced'])
        ])

        total_sales = sum(orders.mapped('amount_total'))
        total_orders = len(orders)

        # Get payment breakdown
        payments = {}
        for order in orders:
            for payment in order.payment_ids:
                method_name = payment.payment_method_id.name
                payments[method_name] = payments.get(method_name, 0) + payment.amount

        # Get refunds
        refund_orders = self.env['pos.order'].sudo().search([
            ('date_order', '>=', date_start),
            ('date_order', '<', date_stop),
            ('state', 'in', ['paid', 'done', 'invoiced']),
            ('amount_total', '<', 0)
        ])
        total_refunds = sum(refund_orders.mapped('amount_total'))

        return {
            'total_sales': total_sales,
            'total_orders': total_orders,
            'total_refunds': abs(total_refunds),
            'net_sales': total_sales,
            'payments': payments,
        }

    @api.model
    def get_sales_summary_data(self):
        """Main method to get all sales summary data"""
        user_tz = self._get_user_timezone()
        today = datetime.now(user_tz)

        # Get date ranges
        today_start, today_stop = self._get_today_range()
        month_start, month_stop = self._get_month_range()
        year_start, year_stop = self._get_year_range()

        # Get sessions grouped data
        sessions = self._get_sessions_today()

        # Get today's summary
        today_summary = self._get_today_summary()

        # Get top products for different periods
        top_products_today = self._get_top_products(today_start, today_stop, 20)
        top_products_month = self._get_top_products(month_start, month_stop, 20)
        top_products_year = self._get_top_products(year_start, year_stop, 20)

        # Get currency
        currency = self.env.company.currency_id

        return {
            'date': today.strftime('%Y-%m-%d %H:%M:%S'),
            'date_display': today.strftime('%B %d, %Y'),
            'month_name': today.strftime('%B %Y'),
            'year': today.strftime('%Y'),
            'company_name': self.env.company.name,
            'currency_symbol': currency.symbol,
            'currency_position': currency.position,
            'sessions': sessions,
            'today_summary': today_summary,
            'top_products_today': top_products_today,
            'top_products_month': top_products_month,
            'top_products_year': top_products_year,
        }

    @api.model
    def _get_report_values(self, docids, data=None):
        """Get report values for QWeb report"""
        return self.get_sales_summary_data()

