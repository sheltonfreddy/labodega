# -*- coding: utf-8 -*-
from odoo import api, fields, models


class PosConfig(models.Model):
    _inherit = 'pos.config'

    pos_type = fields.Selection([
        ('restaurant', 'Restaurant'),
        ('supermarket', 'Supermarket'),
    ], required=True, default='supermarket',
       string="POS Type",
       help="Determines which product categories are shown in this POS.")
    magellan_bridge_url = fields.Char(
        string="Magellan Bridge URL",
        help="URL of the Raspberry Pi bridge for this terminal (e.g., https://10.0.0.34:8000 or https://172.16.19.185:8000). "
             "Each terminal can have its own scale/scanner. Leave empty to use the fallback default.",
        placeholder="https://10.0.0.34:8000"
    )
    allowed_user_ids = fields.Many2many(
        'res.users',
        'pos_config_allowed_users_rel',
        'config_id',
        'user_id',
        string="Allowed Users",
        help="Users who are allowed to open this POS terminal. "
             "Leave empty to allow all users with POS access."
    )
    restrict_user_access = fields.Boolean(
        string="Restrict User Access",
        default=False,
        help="If enabled, only the selected users can see and open this POS terminal."
    )

    def _get_available_categories(self):
        """Override to filter categories by pos_type"""
        categories = super()._get_available_categories()
        if self.pos_type:
            categories = categories.filtered(lambda c: c.pos_type == self.pos_type)
        return categories

    def _get_available_product_domain(self):
        """Override to filter products by pos_type categories"""
        # Get base domain (company, active, available_in_pos, sale_ok)
        domain = [
            *self.env['product.product']._check_company_domain(self.company_id),
            ('active', '=', True),
            ('available_in_pos', '=', True),
            ('sale_ok', '=', True),
        ]

        # Filter by pos_type categories
        if self.pos_type:
            matching_categories = self.env['pos.category'].search([
                ('pos_type', '=', self.pos_type)
            ])
            if matching_categories:
                domain.append(('pos_categ_ids', 'in', matching_categories.ids))

        return domain


class PosCategory(models.Model):
    _inherit = 'pos.category'

    pos_type = fields.Selection([
        ('restaurant', 'Restaurant'),
        ('supermarket', 'Supermarket')
    ], required=True, default='supermarket',
       string="POS Type",
       help="Determines which POS terminals will show this category")

    @api.model
    def _load_pos_data_domain(self, data):
        """Override to filter categories by pos_type matching the POS config"""
        domain = super()._load_pos_data_domain(data)

        # Get the POS config
        config_data = data.get('pos.config', {}).get('data', [{}])
        if config_data:
            pos_type = config_data[0].get('pos_type')
            if pos_type:
                domain = domain + [('pos_type', '=', pos_type)]

        return domain


