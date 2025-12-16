# -*- coding: utf-8 -*-
import requests
import logging
from odoo import http
from odoo.http import request

_logger = logging.getLogger(__name__)


class MagellanBridgeController(http.Controller):
    """
    Proxy controller to forward requests from POS frontend to Raspberry Pi bridge
    This solves HTTPS/HTTP mixed content issues
    """

    def _get_bridge_url(self):
        """Get the bridge URL from system parameters or use default"""
        bridge_url = request.env['ir.config_parameter'].sudo().get_param(
            'labodega_pos.bridge_url',
            'http://10.0.0.35:8000'
        )
        return bridge_url

    @http.route('/pos/magellan/barcode', type='json', auth='user', methods=['POST'], csrf=False)
    def get_barcode(self):
        """
        Proxy endpoint for barcode reading
        Returns: {"barcode": "123456789"} or {"barcode": null}
        """
        try:
            bridge_url = self._get_bridge_url()
            response = requests.get(
                f"{bridge_url}/barcode",
                timeout=2
            )
            response.raise_for_status()
            return response.json()
        except requests.exceptions.RequestException as e:
            _logger.error(f"Error connecting to Magellan bridge /barcode: {e}")
            return {"barcode": None, "error": str(e)}
        except Exception as e:
            _logger.error(f"Unexpected error in /pos/magellan/barcode: {e}")
            return {"barcode": None, "error": str(e)}

    @http.route('/pos/magellan/weight', type='json', auth='user', methods=['POST'], csrf=False)
    def get_weight(self):
        """
        Proxy endpoint for weight reading
        Returns: {"weight": 0.450, "raw": "S110045"} or {"weight": null, "error": "..."}
        """
        try:
            bridge_url = self._get_bridge_url()
            response = requests.get(
                f"{bridge_url}/weight",
                timeout=3
            )
            response.raise_for_status()
            return response.json()
        except requests.exceptions.RequestException as e:
            _logger.error(f"Error connecting to Magellan bridge /weight: {e}")
            return {"weight": None, "error": str(e)}
        except Exception as e:
            _logger.error(f"Unexpected error in /pos/magellan/weight: {e}")
            return {"weight": None, "error": str(e)}

    @http.route('/pos/magellan/status', type='json', auth='user', methods=['POST'], csrf=False)
    def get_status(self):
        """
        Check if the bridge is reachable
        Returns: {"status": "ok"} or {"status": "error", "error": "..."}
        """
        try:
            bridge_url = self._get_bridge_url()
            response = requests.get(
                f"{bridge_url}/",
                timeout=2
            )
            response.raise_for_status()
            data = response.json()
            return {"status": "ok", "bridge_info": data}
        except requests.exceptions.RequestException as e:
            _logger.error(f"Error connecting to Magellan bridge: {e}")
            return {"status": "error", "error": str(e)}
        except Exception as e:
            _logger.error(f"Unexpected error in /pos/magellan/status: {e}")
            return {"status": "error", "error": str(e)}

