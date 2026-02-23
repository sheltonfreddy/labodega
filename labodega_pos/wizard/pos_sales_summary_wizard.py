# -*- coding: utf-8 -*-
from datetime import datetime, timedelta
import pytz
from odoo import api, fields, models, _


class PosSalesSummaryWizardSessionLine(models.TransientModel):
    _name = 'pos.sales.summary.wizard.session.line'
    _description = 'POS Sales Summary Session Line'

    wizard_id = fields.Many2one('pos.sales.summary.wizard', string='Wizard', ondelete='cascade')
    session_id = fields.Many2one('pos.session', string='Session')
    session_name = fields.Char(string='Session')
    config_name = fields.Char(string='POS')
    user_name = fields.Char(string='User')
    state = fields.Char(string='State')
    start_at = fields.Datetime(string='Start')
    total_orders = fields.Integer(string='Orders')
    total_sales = fields.Float(string='Sales', digits='Product Price')


class PosSalesSummaryWizardProductLine(models.TransientModel):
    _name = 'pos.sales.summary.wizard.product.line'
    _description = 'POS Sales Summary Product Line'

    wizard_id = fields.Many2one('pos.sales.summary.wizard', string='Wizard', ondelete='cascade')
    wizard_month_id = fields.Many2one('pos.sales.summary.wizard', string='Wizard Month', ondelete='cascade')
    wizard_year_id = fields.Many2one('pos.sales.summary.wizard', string='Wizard Year', ondelete='cascade')
    rank = fields.Integer(string='#')
    product_id = fields.Many2one('product.product', string='Product')
    product_name = fields.Char(string='Product')
    total_qty = fields.Float(string='Qty Sold', digits='Product Unit of Measure')
    total_amount = fields.Float(string='Amount', digits='Product Price')


class PosSalesSummaryWizard(models.TransientModel):
    _name = 'pos.sales.summary.wizard'
    _description = 'POS Sales Summary Wizard'

    report_date = fields.Datetime(string='Report Date', default=fields.Datetime.now)
    month_name = fields.Char(string='Month')
    year_name = fields.Char(string='Year')

    # Today's summary
    total_sales_today = fields.Float(string='Total Sales Today', digits='Product Price')
    total_orders_today = fields.Integer(string='Total Orders Today')
    total_refunds_today = fields.Float(string='Total Refunds Today', digits='Product Price')

    # Session lines
    session_line_ids = fields.One2many(
        'pos.sales.summary.wizard.session.line', 'wizard_id', string='Sessions')

    # Top products today
    top_products_today_ids = fields.One2many(
        'pos.sales.summary.wizard.product.line', 'wizard_id', string='Top Products Today')

    # Top products this month
    top_products_month_ids = fields.One2many(
        'pos.sales.summary.wizard.product.line', 'wizard_month_id', string='Top Products This Month')

    # Top products this year
    top_products_year_ids = fields.One2many(
        'pos.sales.summary.wizard.product.line', 'wizard_year_id', string='Top Products This Year')

    @api.model
    def default_get(self, fields_list):
        """Load data on wizard open"""
        res = super().default_get(fields_list)
        if self.env.context.get('default_auto_load'):
            res.update(self._get_report_data())
        return res

    def _get_user_timezone(self):
        """Get user timezone"""
        return pytz.timezone(self.env.context.get('tz') or self.env.user.tz or 'UTC')

    def _get_today_range(self):
        """Get today's date range in UTC"""
        user_tz = self._get_user_timezone()
        today = datetime.now(user_tz).replace(hour=0, minute=0, second=0, microsecond=0)
        tomorrow = today + timedelta(days=1)

        date_start = today.astimezone(pytz.UTC).replace(tzinfo=None)
        date_stop = tomorrow.astimezone(pytz.UTC).replace(tzinfo=None)

        return date_start, date_stop

    def _get_month_range(self):
        """Get current month's date range in UTC"""
        user_tz = self._get_user_timezone()
        today = datetime.now(user_tz)
        month_start = today.replace(day=1, hour=0, minute=0, second=0, microsecond=0)

        if today.month == 12:
            month_end = today.replace(year=today.year + 1, month=1, day=1, hour=0, minute=0, second=0, microsecond=0)
        else:
            month_end = today.replace(month=today.month + 1, day=1, hour=0, minute=0, second=0, microsecond=0)

        date_start = month_start.astimezone(pytz.UTC).replace(tzinfo=None)
        date_stop = month_end.astimezone(pytz.UTC).replace(tzinfo=None)

        return date_start, date_stop

    def _get_year_range(self):
        """Get current year's date range in UTC"""
        user_tz = self._get_user_timezone()
        today = datetime.now(user_tz)
        year_start = today.replace(month=1, day=1, hour=0, minute=0, second=0, microsecond=0)
        year_end = today.replace(year=today.year + 1, month=1, day=1, hour=0, minute=0, second=0, microsecond=0)

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

        # Handle JSONB name field (Odoo 18 stores translations as JSONB)
        for r in results:
            if isinstance(r.get('product_name'), dict):
                r['product_name'] = r['product_name'].get('en_US') or list(r['product_name'].values())[0] if r['product_name'] else 'Unknown'

        return results

    def _get_report_data(self):
        """Get all report data"""
        user_tz = self._get_user_timezone()
        today = datetime.now(user_tz)

        # Get date ranges
        today_start, today_stop = self._get_today_range()
        month_start, month_stop = self._get_month_range()
        year_start, year_stop = self._get_year_range()

        # Get today's sessions
        sessions = self.env['pos.session'].search([
            ('start_at', '>=', today_start),
            ('start_at', '<', today_stop),
        ], order='start_at desc')

        session_lines = []
        total_sales = 0
        total_orders = 0
        total_refunds = 0

        for session in sessions:
            orders = self.env['pos.order'].search([
                ('session_id', '=', session.id),
                ('state', 'in', ['paid', 'done', 'invoiced'])
            ])

            session_sales = sum(o.amount_total for o in orders if o.amount_total > 0)
            session_refunds = sum(abs(o.amount_total) for o in orders if o.amount_total < 0)
            session_order_count = len(orders)

            total_sales += session_sales
            total_orders += session_order_count
            total_refunds += session_refunds

            session_lines.append((0, 0, {
                'session_id': session.id,
                'session_name': session.name,
                'config_name': session.config_id.name,
                'user_name': session.user_id.name,
                'state': dict(session._fields['state'].selection).get(session.state, session.state),
                'start_at': session.start_at,
                'total_orders': session_order_count,
                'total_sales': session_sales,
            }))

        # Get top products
        top_today = self._get_top_products(today_start, today_stop, 20)
        top_month = self._get_top_products(month_start, month_stop, 20)
        top_year = self._get_top_products(year_start, year_stop, 20)

        top_today_lines = [(0, 0, {
            'rank': i + 1,
            'product_id': p['product_id'],
            'product_name': p['product_name'],
            'total_qty': p['total_qty'],
            'total_amount': p['total_amount'],
        }) for i, p in enumerate(top_today)]

        top_month_lines = [(0, 0, {
            'rank': i + 1,
            'product_id': p['product_id'],
            'product_name': p['product_name'],
            'total_qty': p['total_qty'],
            'total_amount': p['total_amount'],
        }) for i, p in enumerate(top_month)]

        top_year_lines = [(0, 0, {
            'rank': i + 1,
            'product_id': p['product_id'],
            'product_name': p['product_name'],
            'total_qty': p['total_qty'],
            'total_amount': p['total_amount'],
        }) for i, p in enumerate(top_year)]

        return {
            'report_date': fields.Datetime.now(),
            'month_name': today.strftime('%B %Y'),
            'year_name': str(today.year),
            'total_sales_today': total_sales,
            'total_orders_today': total_orders,
            'total_refunds_today': total_refunds,
            'session_line_ids': session_lines,
            'top_products_today_ids': top_today_lines,
            'top_products_month_ids': top_month_lines,
            'top_products_year_ids': top_year_lines,
        }

    def action_refresh(self):
        """Refresh the report data"""
        self.ensure_one()

        # Clear existing lines
        self.session_line_ids.unlink()
        self.top_products_today_ids.unlink()
        self.top_products_month_ids.unlink()
        self.top_products_year_ids.unlink()

        # Get new data
        data = self._get_report_data()
        self.write(data)

        return {
            'type': 'ir.actions.act_window',
            'res_model': 'pos.sales.summary.wizard',
            'res_id': self.id,
            'view_mode': 'form',
            'target': 'new',
        }

    def action_print_report(self):
        """Print the sales summary report"""
        self.ensure_one()
        return self.env.ref('labodega_pos.action_report_pos_sales_summary').report_action(self)

