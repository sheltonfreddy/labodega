# -*- coding: utf-8 -*-
from odoo import fields, models


class PosConfig(models.Model):
    _inherit = 'pos.config'

    magellan_bridge_url = fields.Char(
        string="Magellan Bridge URL",
        help="URL of the Raspberry Pi bridge for this terminal (e.g., http://100.101.102.103:8000). "
             "Leave empty to use the system-wide default.",
        placeholder="http://100.101.102.103:8000"
    )

