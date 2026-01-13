# -*- coding: utf-8 -*-
from odoo import fields, models


class PosConfig(models.Model):
    _inherit = 'pos.config'

    magellan_bridge_url = fields.Char(
        string="Magellan Bridge URL",
        help="URL of the Raspberry Pi bridge for this terminal (e.g., https://10.0.0.34:8000 or https://172.16.19.185:8000). "
             "Each terminal can have its own scale/scanner. Leave empty to use the fallback default.",
        placeholder="https://10.0.0.34:8000"
    )

