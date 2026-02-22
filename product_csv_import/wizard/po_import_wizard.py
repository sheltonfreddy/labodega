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

    # Category fields
    category_id = fields.Many2one('product.category', string='Category')
    pos_category_id = fields.Many2one('pos.category', string='POS Category')

    # Price and Margin fields
    current_cost = fields.Float(string='Current Cost', readonly=True,
                                 help='Current cost in Odoo')
    current_sale_price = fields.Float(string='Current Sale Price', readonly=True,
                                       help='Current sale price in Odoo')
    current_margin = fields.Float(string='Current Margin %', readonly=True,
                                   help='Current margin in Odoo')
    sale_price = fields.Float(string='New Sale Price',
                              help='Sale price to set (leave 0 to keep existing)')
    margin_percent = fields.Float(string='Margin %',
                                  help='Margin percentage (edit to recalculate sale price)')
    update_price = fields.Boolean(string='Update', default=False,
                                  help='Check to update cost and sale price for this product')

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

    @api.onchange('margin_percent')
    def _onchange_margin_percent(self):
        """Recalculate sale price when margin is changed"""
        if self.unit_cost and self.margin_percent:
            # Sale Price = Cost / (1 - Margin%)
            # e.g., Cost $10, Margin 30% → Price = 10 / (1 - 0.30) = $14.29
            if self.margin_percent < 100:
                self.sale_price = self.unit_cost / (1 - self.margin_percent / 100)
            self.update_price = True

    @api.onchange('sale_price')
    def _onchange_sale_price(self):
        """Recalculate margin when sale price is changed"""
        if self.sale_price and self.unit_cost and self.sale_price > 0:
            # Margin% = (Price - Cost) / Price * 100
            self.margin_percent = ((self.sale_price - self.unit_cost) / self.sale_price) * 100
            self.update_price = True

    @api.onchange('update_price')
    def _onchange_update_price(self):
        """When update_price is checked, calculate margin if not set"""
        if self.update_price and not self.sale_price and self.unit_cost:
            # Default to 30% margin if no sale price set
            default_margin = self.wizard_id.default_margin or 30.0
            self.margin_percent = default_margin
            self.sale_price = self.unit_cost / (1 - default_margin / 100)


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
    normalize_barcodes = fields.Boolean(
        string='Normalize Barcodes',
        default=True,
        help='If checked, update product barcodes to normalized format (10-digit vendor format)')
    update_product_prices = fields.Boolean(
        string='Update Product Prices',
        default=False,
        help='If checked, update product cost and sale price for lines marked "Update"')
    default_margin = fields.Float(
        string='Default Margin %',
        default=30.0,
        help='Default margin percentage for new products or when calculating sale price')
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
    # Template: Vendor Item Code, Product Name, Barcode, Quantity, Unit Cost, Category, POS Category
    COL_VENDOR_CODE = 0    # Vendor's item code
    COL_NAME = 1           # Product Name
    COL_BARCODE = 2        # Barcode (primary match key)
    COL_QTY = 3            # Quantity
    COL_UNIT_COST = 4      # Unit Cost
    COL_CATEGORY = 5       # Product Category (optional)
    COL_POS_CATEGORY = 6   # POS Category (optional)

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

    def _find_or_create_category(self, category_name):
        """Find category by name or create if not exists"""
        if not category_name:
            return None
        Category = self.env['product.category']
        category = Category.search([('name', '=ilike', category_name)], limit=1)
        if not category:
            category = Category.create({'name': category_name})
        return category

    def _find_or_create_pos_category(self, pos_category_name):
        """Find POS category by name or create if not exists"""
        if not pos_category_name:
            return None
        PosCategory = self.env['pos.category']
        pos_category = PosCategory.search([('name', '=ilike', pos_category_name)], limit=1)
        if not pos_category:
            pos_category = PosCategory.create({'name': pos_category_name})
        return pos_category

    # ========================================================================
    # Barcode Normalization Functions (from scale_bridge.py)
    # ========================================================================

    def _calculate_upc_check_digit(self, barcode):
        """
        Calculate UPC/EAN check digit using Modulo 10 algorithm.
        Works for UPC-A (11 digits input) and EAN-13 (12 digits input).
        """
        if not barcode or not barcode.isdigit():
            return ""

        total = 0
        for i, digit in enumerate(barcode):
            if i % 2 == 0:
                total += int(digit) * 3
            else:
                total += int(digit)

        check = (10 - (total % 10)) % 10
        return str(check)

    def _normalize_upc_barcode(self, barcode):
        """
        Normalize UPC/EAN barcodes to match Odoo product barcodes.
        Matches vendor format: strip leading zeros, no check digit.
        """
        if not barcode or not barcode.isdigit():
            return barcode

        length = len(barcode)

        # Handle scanners that omit check digit (send 11 digits instead of 12)
        if length == 11:
            check = self._calculate_upc_check_digit(barcode)
            barcode = barcode + check
            length = 12

        # Match vendor format: strip leading zeros, no check digit
        # 12 digits (full UPC) starting with 0 → strip to 10 digits
        if length == 12 and barcode.startswith('0'):
            return barcode[1:11]  # Remove leading 0 and check digit

        # 11 digits starting with 0 → strip to 10 digits
        if length == 11 and barcode.startswith('0'):
            return barcode[1:]  # Remove leading 0

        return barcode

    def _generate_barcode_variants(self, barcode):
        """
        Generate possible barcode variants to search in Odoo.
        This helps find products that may have been imported with different formats.
        """
        if not barcode or not barcode.isdigit():
            return [barcode] if barcode else []

        variants = []
        length = len(barcode)

        # Original
        variants.append(barcode)

        # For 10-digit barcodes, try with leading zero (11 digits) and full UPC (12 digits)
        if length == 10:
            with_zero = '0' + barcode
            variants.append(with_zero)
            check = self._calculate_upc_check_digit(with_zero)
            variants.append(with_zero + check)  # Full 12-digit UPC

        # For 11-digit barcodes, try with and without check digit
        elif length == 11:
            check = self._calculate_upc_check_digit(barcode)
            variants.append(barcode + check)  # Add check digit
            if barcode.startswith('0'):
                variants.append(barcode[1:])  # Strip leading zero

        # For 12-digit barcodes starting with 0, try 10 and 11 digit versions
        elif length == 12 and barcode.startswith('0'):
            variants.append(barcode[1:])  # 11 digits
            variants.append(barcode[1:11])  # 10 digits (vendor format)

        # For 14-digit ITF-14 barcodes, try the inner UPC
        elif length == 14:
            inner_11 = barcode[2:13]
            variants.append(inner_11)
            check = self._calculate_upc_check_digit(inner_11)
            variants.append(inner_11 + check)  # 12-digit UPC
            if inner_11.startswith('0'):
                variants.append(inner_11[1:])  # 10-digit vendor format

        # Remove duplicates while preserving order
        seen = set()
        unique_variants = []
        for v in variants:
            if v not in seen:
                seen.add(v)
                unique_variants.append(v)

        return unique_variants

    def _find_product_by_barcode(self, barcode):
        """Find product by barcode, trying all normalized variants.
        Returns tuple: (product, matched_barcode_variant)
        """
        if not barcode:
            return None, None

        # Generate all possible barcode variants
        variants = self._generate_barcode_variants(barcode)

        # Search for product with any variant
        for variant in variants:
            product = self.env['product.product'].search([('barcode', '=', variant)], limit=1)
            if product:
                return product, variant

        return None, None

    def _normalize_product_barcode(self, product, original_barcode):
        """
        Normalize the product's barcode to vendor format (10-digit).
        Only updates if the current barcode is different from normalized.
        Returns True if barcode was updated, False otherwise.
        """
        if not product or not original_barcode:
            return False

        normalized = self._normalize_upc_barcode(original_barcode)

        # Only update if different and normalized is valid
        if normalized and normalized != product.barcode and normalized.isdigit():
            # Check no other product has this normalized barcode
            existing = self.env['product.product'].search([
                ('barcode', '=', normalized),
                ('id', '!=', product.id)
            ], limit=1)

            if not existing:
                product.write({'barcode': normalized})
                return True

        return False

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

                # Parse optional category columns
                category_name = self._clean_text(row[self.COL_CATEGORY]) if len(row) > self.COL_CATEGORY else ''
                pos_category_name = self._clean_text(row[self.COL_POS_CATEGORY]) if len(row) > self.COL_POS_CATEGORY else ''

                # Find or create categories
                category = self._find_or_create_category(category_name) if category_name else None
                pos_category = self._find_or_create_pos_category(pos_category_name) if pos_category_name else None

                if not name:
                    continue

                # Find product
                product = None
                matched_variant = None
                status = 'error'
                status_message = 'Product not found'

                if barcode:
                    product, matched_variant = self._find_product_by_barcode(barcode)

                if not product and vendor_code:
                    product = self._find_product_by_vendor_code(vendor_code, self.vendor_id.id)

                if product:
                    status = 'matched'
                    normalized = self._normalize_upc_barcode(barcode) if barcode else None
                    if self.normalize_barcodes and normalized and product.barcode != normalized:
                        status_message = f'Matched: {product.display_name} (barcode will normalize: {product.barcode} → {normalized})'
                    else:
                        status_message = f'Matched: {product.display_name}'

                    # Get current pricing info
                    current_cost = product.standard_price or 0.0
                    current_sale_price = product.list_price or 0.0

                    # Calculate current margin if both prices exist
                    if current_sale_price > 0 and current_cost > 0:
                        current_margin = ((current_sale_price - current_cost) / current_sale_price) * 100
                    else:
                        current_margin = self.default_margin

                    # For preview, show what the new sale price would be using existing margin
                    if unit_cost > 0 and current_margin > 0 and current_margin < 100:
                        new_sale_price = unit_cost / (1 - current_margin / 100)
                    else:
                        new_sale_price = current_sale_price

                elif self.create_missing_products:
                    status = 'new'
                    status_message = 'Will create new product'
                    current_cost = 0.0
                    current_sale_price = 0.0
                    current_margin = self.default_margin
                    # Calculate sale price for new product using default margin
                    if unit_cost > 0 and current_margin < 100:
                        new_sale_price = unit_cost / (1 - current_margin / 100)
                    else:
                        new_sale_price = 0.0
                else:
                    status = 'error'
                    status_message = 'Product not found (creation disabled)'
                    current_cost = 0.0
                    current_sale_price = 0.0
                    current_margin = 0.0
                    new_sale_price = 0.0

                preview_lines.append({
                    'wizard_id': self.id,
                    'vendor_code': vendor_code,
                    'name': name,
                    'barcode': barcode,
                    'quantity': qty,
                    'unit_cost': unit_cost,
                    'product_id': product.id if product else False,
                    'category_id': category.id if category else (product.categ_id.id if product else False),
                    'pos_category_id': pos_category.id if pos_category else (product.pos_categ_ids[0].id if product and product.pos_categ_ids else False),
                    'current_cost': current_cost,
                    'current_sale_price': current_sale_price,
                    'current_margin': current_margin,
                    'sale_price': new_sale_price,
                    'margin_percent': current_margin,
                    'update_price': status == 'new',  # Auto-check for new products
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
        """Import PO from preview lines (with user-edited margins/prices)"""
        self.ensure_one()

        if not self.preview_line_ids:
            raise UserError(_('No preview lines found. Please preview the import first.'))

        # Statistics
        products_created = 0
        products_matched = 0
        barcodes_normalized = 0
        prices_updated = 0
        vendor_prices_updated = 0
        skipped = 0
        errors = []

        # PO lines to create
        po_lines = []

        for line in self.preview_line_ids:
            try:
                if line.status == 'error':
                    skipped += 1
                    continue

                product = line.product_id
                barcode = line.barcode
                vendor_code = line.vendor_code
                name = line.name
                qty = line.quantity
                unit_cost = line.unit_cost

                # Handle product creation or matching
                if line.status == 'new' and not product:
                    # Normalize barcode before creating new product
                    normalized_barcode = self._normalize_upc_barcode(barcode) if barcode else barcode

                    # Create product with sale price and categories from preview line
                    product = self._create_product_with_price(
                        name, normalized_barcode, unit_cost,
                        line.sale_price, vendor_code,
                        category_id=line.category_id.id if line.category_id else False,
                        pos_category_id=line.pos_category_id.id if line.pos_category_id else False
                    )
                    products_created += 1
                elif product:
                    products_matched += 1

                    # Normalize barcode if option is enabled
                    if self.normalize_barcodes and barcode:
                        if self._normalize_product_barcode(product, barcode):
                            barcodes_normalized += 1

                    # Update product prices if marked for update
                    if self.update_product_prices and line.update_price:
                        if self._update_product_prices(product, unit_cost, line.sale_price):
                            prices_updated += 1

                    # Update categories if specified in preview line
                    if line.category_id and line.category_id != product.categ_id:
                        product.write({'categ_id': line.category_id.id})
                    if line.pos_category_id:
                        current_pos_cats = product.pos_categ_ids.ids
                        if line.pos_category_id.id not in current_pos_cats:
                            product.write({'pos_categ_ids': [(4, line.pos_category_id.id)]})
                else:
                    errors.append(f"Line {line.name}: Product not found")
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
                errors.append(f"Line {line.name}: {str(e)}")

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
            f"🔄 Barcodes Normalized: {barcodes_normalized}",
            f"💲 Prices Updated: {prices_updated}",
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

    def _create_product_with_price(self, name, barcode, cost, sale_price, vendor_code, category_id=False, pos_category_id=False):
        """Create a new product with cost, sale price, and categories"""
        vals = {
            'name': name,
            'barcode': barcode if barcode else False,
            'type': 'consu',
            'standard_price': cost,
            'list_price': sale_price if sale_price else cost,
            'available_in_pos': True,
            'default_code': vendor_code if not barcode else False,
        }
        if category_id:
            vals['categ_id'] = category_id
        if pos_category_id:
            vals['pos_categ_ids'] = [(6, 0, [pos_category_id])]
        return self.env['product.product'].create(vals)

    def _update_product_prices(self, product, cost, sale_price):
        """Update product cost and sale price. Returns True if updated."""
        if not product:
            return False

        updates = {}
        if cost and cost != product.standard_price:
            updates['standard_price'] = cost
        if sale_price and sale_price != product.list_price:
            updates['list_price'] = sale_price

        if updates:
            product.write(updates)
            return True
        return False

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




