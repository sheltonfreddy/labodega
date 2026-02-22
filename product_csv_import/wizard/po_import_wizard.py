import base64
import csv
import io
from odoo import models, fields, api, _
from odoo.exceptions import UserError


class POImportWizardLine(models.TransientModel):
    _name = 'po.import.wizard.line'
    _description = 'PO Import Preview Line'

    wizard_id = fields.Many2one('po.import.wizard', string='Wizard', ondelete='cascade')
    vendor_code = fields.Char(string='Vendor Code')
    name = fields.Char(string='Product Name')
    barcode = fields.Char(string='Barcode')
    quantity = fields.Float(string='Quantity')
    unit_cost = fields.Float(string='Unit Cost')
    line_total = fields.Float(string='Total', compute='_compute_line_total')
    product_id = fields.Many2one('product.product', string='Matched Product')
    status = fields.Selection([
        ('matched', 'Matched'),
        ('new', 'Will Create'),
        ('error', 'Error'),
    ], string='Status')
    status_message = fields.Char(string='Status Message')

    @api.depends('quantity', 'unit_cost')
    def _compute_line_total(self):
        for line in self:
            line.line_total = line.quantity * line.unit_cost


class POImportWizard(models.TransientModel):
    _name = 'po.import.wizard'
    _description = 'Import Purchase Order from CSV'

    csv_file = fields.Binary(string='CSV File', required=True)
    csv_filename = fields.Char(string='Filename')
    vendor_id = fields.Many2one('res.partner', string='Vendor', required=True,
                                 domain=[('supplier_rank', '>', 0)],
                                 help='Select the vendor for this purchase order')

    # Options
    create_missing_products = fields.Boolean(
        string='Create Missing Products',
        default=True,
        help='If checked, products not found by barcode will be created')
    update_vendor_pricelist = fields.Boolean(
        string='Update Vendor Pricelist',
        default=True,
        help='Update/Create vendor-specific pricing (product.supplierinfo)')
    auto_confirm_po = fields.Boolean(
        string='Auto Confirm PO',
        default=False,
        help='If checked, the PO will be confirmed automatically')

    # Preview
    preview_line_ids = fields.One2many('po.import.wizard.line', 'wizard_id', string='Preview Lines')
    preview_total = fields.Float(string='Total Amount', compute='_compute_preview_total')
    preview_count_matched = fields.Integer(string='Matched', compute='_compute_preview_stats')
    preview_count_new = fields.Integer(string='New', compute='_compute_preview_stats')
    preview_count_error = fields.Integer(string='Errors', compute='_compute_preview_stats')

    # Results
    result_message = fields.Text(string='Import Result', readonly=True)
    created_po_id = fields.Many2one('purchase.order', string='Created PO', readonly=True)
    state = fields.Selection([
        ('draft', 'Draft'),
        ('preview', 'Preview'),
        ('done', 'Done'),
    ], default='draft')

    @api.depends('preview_line_ids.line_total')
    def _compute_preview_total(self):
        for wizard in self:
            wizard.preview_total = sum(wizard.preview_line_ids.mapped('line_total'))

    @api.depends('preview_line_ids.status')
    def _compute_preview_stats(self):
        for wizard in self:
            wizard.preview_count_matched = len(wizard.preview_line_ids.filtered(lambda l: l.status == 'matched'))
            wizard.preview_count_new = len(wizard.preview_line_ids.filtered(lambda l: l.status == 'new'))
            wizard.preview_count_error = len(wizard.preview_line_ids.filtered(lambda l: l.status == 'error'))

    # CSV Column indices (0-based)
    # Template: Vendor Item Code, Product Name, Barcode, Quantity, Unit Cost
    COL_VENDOR_CODE = 0    # Vendor's item code
    COL_NAME = 1           # Product Name
    COL_BARCODE = 2        # Barcode (primary match key)
    COL_QTY = 3            # Quantity
    COL_UNIT_COST = 4      # Unit Cost

    def _clean_price(self, price_str):
        """Remove $ and convert to float"""
        if not price_str or str(price_str).strip() == '':
            return 0.0
        cleaned = str(price_str).replace('$', '').replace(',', '').strip()
        try:
            return float(cleaned)
        except ValueError:
            return 0.0

    def _clean_qty(self, qty_str):
        """Convert quantity to float"""
        if not qty_str or str(qty_str).strip() == '':
            return 1.0
        try:
            return float(str(qty_str).strip())
        except ValueError:
            return 1.0

    def _clean_barcode(self, barcode_str):
        """Clean barcode - remove spaces"""
        if not barcode_str:
            return ''
        return str(barcode_str).strip()

    def _clean_text(self, text_str):
        """Clean text - remove extra spaces"""
        if not text_str:
            return ''
        return ' '.join(str(text_str).split())

    def _find_product_by_barcode(self, barcode):
        """Find product by barcode"""
        if not barcode:
            return None
        return self.env['product.product'].search([('barcode', '=', barcode)], limit=1)

    def _find_product_by_vendor_code(self, vendor_code, vendor_id):
        """Find product by vendor code in supplierinfo"""
        if not vendor_code:
            return None
        supplierinfo = self.env['product.supplierinfo'].search([
            ('partner_id', '=', vendor_id),
            ('product_code', '=', vendor_code)
        ], limit=1)
        if supplierinfo and supplierinfo.product_id:
            return supplierinfo.product_id
        elif supplierinfo and supplierinfo.product_tmpl_id:
            return supplierinfo.product_tmpl_id.product_variant_id
        return None

    def _create_product(self, name, barcode, cost, vendor_code):
        """Create a new product"""
        vals = {
            'name': name,
            'barcode': barcode if barcode else False,
            'type': 'consu',
            'standard_price': cost,
            'available_in_pos': True,
            'default_code': vendor_code if not barcode else False,
        }
        return self.env['product.product'].create(vals)

    def _update_vendor_pricelist(self, product, vendor_id, vendor_code, price):
        """Create or update vendor pricelist entry (product.supplierinfo)"""
        SupplierInfo = self.env['product.supplierinfo']

        # Search for existing supplierinfo
        existing = SupplierInfo.search([
            ('partner_id', '=', vendor_id),
            ('product_tmpl_id', '=', product.product_tmpl_id.id)
        ], limit=1)

        if existing:
            # Update existing
            existing.write({
                'product_code': vendor_code,
                'price': price,
            })
        else:
            # Create new
            SupplierInfo.create({
                'partner_id': vendor_id,
                'product_tmpl_id': product.product_tmpl_id.id,
                'product_code': vendor_code,
                'price': price,
                'min_qty': 1,
            })

    def action_preview(self):
        """Parse CSV and show preview before importing"""
        self.ensure_one()

        if not self.csv_file:
            raise UserError(_('Please upload a CSV file.'))

        if not self.vendor_id:
            raise UserError(_('Please select a vendor.'))

        # Clear existing preview lines
        self.preview_line_ids.unlink()

        # Decode the CSV file
        csv_data = base64.b64decode(self.csv_file)
        csv_file = io.StringIO(csv_data.decode('utf-8'))
        reader = csv.reader(csv_file)

        # Skip header row
        next(reader, None)

        preview_lines = []

        for row_num, row in enumerate(reader, start=2):
            try:
                if len(row) < 4:
                    continue

                vendor_code = self._clean_text(row[self.COL_VENDOR_CODE])
                name = self._clean_text(row[self.COL_NAME])
                barcode = self._clean_barcode(row[self.COL_BARCODE])
                qty = self._clean_qty(row[self.COL_QTY])
                unit_cost = self._clean_price(row[self.COL_UNIT_COST]) if len(row) > self.COL_UNIT_COST else 0.0

                if not name:
                    continue

                # Find product
                product = None
                status = 'error'
                status_message = 'Product not found'

                if barcode:
                    product = self._find_product_by_barcode(barcode)

                if not product and vendor_code:
                    product = self._find_product_by_vendor_code(vendor_code, self.vendor_id.id)

                if product:
                    status = 'matched'
                    status_message = f'Matched: {product.display_name}'
                elif self.create_missing_products:
                    status = 'new'
                    status_message = 'Will create new product'
                else:
                    status = 'error'
                    status_message = 'Product not found (creation disabled)'

                preview_lines.append({
                    'wizard_id': self.id,
                    'vendor_code': vendor_code,
                    'name': name,
                    'barcode': barcode,
                    'quantity': qty,
                    'unit_cost': unit_cost,
                    'product_id': product.id if product else False,
                    'status': status,
                    'status_message': status_message,
                })

            except Exception as e:
                preview_lines.append({
                    'wizard_id': self.id,
                    'vendor_code': row[0] if row else '',
                    'name': row[1] if len(row) > 1 else '',
                    'barcode': '',
                    'quantity': 0,
                    'unit_cost': 0,
                    'status': 'error',
                    'status_message': str(e),
                })

        # Create preview lines
        self.env['po.import.wizard.line'].create(preview_lines)
        self.state = 'preview'

        return {
            'type': 'ir.actions.act_window',
            'res_model': 'po.import.wizard',
            'res_id': self.id,
            'view_mode': 'form',
            'target': 'new',
        }

    def action_import(self):
        """Import PO from CSV"""
        self.ensure_one()

        if not self.csv_file:
            raise UserError(_('Please upload a CSV file.'))

        # Decode the CSV file
        csv_data = base64.b64decode(self.csv_file)
        csv_file = io.StringIO(csv_data.decode('utf-8'))
        reader = csv.reader(csv_file)

        # Skip header row
        next(reader, None)

        # Statistics
        products_created = 0
        products_matched = 0
        vendor_prices_updated = 0
        skipped = 0
        errors = []

        # PO lines to create
        po_lines = []

        for row_num, row in enumerate(reader, start=2):
            try:
                if len(row) < 4:  # Minimum: vendor_code, name, barcode, qty
                    skipped += 1
                    continue

                vendor_code = self._clean_text(row[self.COL_VENDOR_CODE])
                name = self._clean_text(row[self.COL_NAME])
                barcode = self._clean_barcode(row[self.COL_BARCODE])
                qty = self._clean_qty(row[self.COL_QTY])
                unit_cost = self._clean_price(row[self.COL_UNIT_COST]) if len(row) > self.COL_UNIT_COST else 0.0

                # Skip rows without name
                if not name:
                    skipped += 1
                    continue

                # Find product: First by barcode, then by vendor code
                product = None

                if barcode:
                    product = self._find_product_by_barcode(barcode)

                if not product and vendor_code:
                    product = self._find_product_by_vendor_code(vendor_code, self.vendor_id.id)

                if product:
                    products_matched += 1
                elif self.create_missing_products:
                    product = self._create_product(name, barcode, unit_cost, vendor_code)
                    products_created += 1
                else:
                    errors.append(f"Row {row_num}: Product not found - {name} (Barcode: {barcode})")
                    skipped += 1
                    continue

                # Update vendor pricelist
                if product and self.update_vendor_pricelist:
                    self._update_vendor_pricelist(product, self.vendor_id.id, vendor_code, unit_cost)
                    vendor_prices_updated += 1

                # Add PO line
                if product:
                    po_lines.append({
                        'product_id': product.id,
                        'name': name,
                        'product_qty': qty,
                        'price_unit': unit_cost,
                    })

            except Exception as e:
                errors.append(f"Row {row_num}: {str(e)}")

        # Create Purchase Order
        po = None
        if po_lines:
            po_vals = {
                'partner_id': self.vendor_id.id,
                'order_line': [(0, 0, line) for line in po_lines],
            }
            po = self.env['purchase.order'].create(po_vals)
            self.created_po_id = po.id

            if self.auto_confirm_po:
                po.button_confirm()

        # Build result message
        result_lines = [
            "=" * 50,
            "IMPORT COMPLETED",
            "=" * 50,
            f"📦 Purchase Order: {po.name if po else 'None'}",
            f"📋 PO Lines Created: {len(po_lines)}",
            "",
            f"✅ Products Matched: {products_matched}",
            f"✅ Products Created: {products_created}",
            f"💰 Vendor Prices Updated: {vendor_prices_updated}",
            f"⏭️  Rows Skipped: {skipped}",
        ]

        if errors:
            result_lines.append(f"\n❌ Errors ({len(errors)}):")
            for error in errors[:10]:
                result_lines.append(f"   - {error}")
            if len(errors) > 10:
                result_lines.append(f"   ... and {len(errors) - 10} more errors")

        self.result_message = "\n".join(result_lines)
        self.state = 'done'

        return {
            'type': 'ir.actions.act_window',
            'res_model': 'po.import.wizard',
            'res_id': self.id,
            'view_mode': 'form',
            'target': 'new',
        }

    def action_view_po(self):
        """Open the created PO"""
        self.ensure_one()
        if not self.created_po_id:
            raise UserError(_('No Purchase Order was created.'))

        return {
            'type': 'ir.actions.act_window',
            'res_model': 'purchase.order',
            'res_id': self.created_po_id.id,
            'view_mode': 'form',
            'target': 'current',
        }

    def action_reset(self):
        """Reset the wizard to import another file"""
        self.ensure_one()
        self.preview_line_ids.unlink()
        self.write({
            'csv_file': False,
            'csv_filename': False,
            'result_message': False,
            'created_po_id': False,
            'state': 'draft',
        })
        return {
            'type': 'ir.actions.act_window',
            'res_model': 'po.import.wizard',
            'res_id': self.id,
            'view_mode': 'form',
            'target': 'new',
        }

    def action_back_to_draft(self):
        """Go back to draft state from preview"""
        self.ensure_one()
        self.preview_line_ids.unlink()
        self.state = 'draft'
        return {
            'type': 'ir.actions.act_window',
            'res_model': 'po.import.wizard',
            'res_id': self.id,
            'view_mode': 'form',
            'target': 'new',
        }




