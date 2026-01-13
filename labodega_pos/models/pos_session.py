# -*- coding: utf-8 -*-
from odoo import models


class PosSession(models.Model):
    _inherit = 'pos.session'

    def _loader_params_pos_config(self):
        """Add magellan_bridge_url to POS config fields loaded in session"""
        result = super()._loader_params_pos_config()
        result['search_params']['fields'].append('magellan_bridge_url')
        return result

