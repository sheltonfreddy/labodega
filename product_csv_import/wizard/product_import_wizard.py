import base64
import csv
import io
from odoo import models, fields, api, _
from odoo.exceptions import UserError


class ProductImportWizard(models.TransientModel):
    _name = 'product.import.wizard'
    _description = 'Import Products from CSV'

    csv_file = fields.Binary(string='CSV File', required=True)
    csv_filename = fields.Char(string='Filename')
    vendor_name = fields.Char(string='Vendor Name', default='DIAZ FOODS', required=True)
    update_name = fields.Boolean(string='Update Product Name', default=True)
    update_cost = fields.Boolean(string='Update Cost', default=True)
    update_sale_price = fields.Boolean(string='Update Sale Price', default=True)
    update_purchase_desc = fields.Boolean(string='Update Purchase Description', default=True)
    update_category = fields.Boolean(string='Update Product Category', default=True)
    update_pos_category = fields.Boolean(string='Update POS Category', default=True)
    create_new_products = fields.Boolean(string='Create New Products', default=True,
                                          help='If unchecked, only existing products will be updated')

    # Results
    result_message = fields.Text(string='Import Result', readonly=True)
    state = fields.Selection([
        ('draft', 'Draft'),
        ('done', 'Done'),
    ], default='draft')

    # CSV Column indices (0-based) - Updated for new CSV format
    # Col E (4): Scale Reads - Barcode
    # Col F (5): Description 1 - Name
    # Col N (13): Unit Cost
    # Col P (15): Sale Price35
    # Col Q (16): Product Category
    # Col R (17): Point of Sale Category
    # Col S (18): Available in POS
    COL_BARCODE = 4       # Scale Reads (Col E)
    COL_NAME = 5          # Description 1 (Col F)
    COL_UNIT_COST = 13    # Unit Cost (Col N)
    COL_SALE_PRICE = 15   # Sale Price35 (Col P)
    COL_CATEGORY = 16     # Product Category (Col Q)
    COL_POS_CATEGORY = 17 # Point of Sale Category (Col R)
    COL_AVAILABLE_POS = 18 # Available in POS (Col S)

    def _clean_price(self, price_str):
        """Remove $ and convert to float"""
        if not price_str or price_str.strip() == '':
            return None
        cleaned = price_str.replace('$', '').replace(',', '').strip()
        try:
            return float(cleaned)
        except ValueError:
            return None

    def _clean_barcode(self, barcode_str):
        """Clean barcode - remove spaces"""
        if not barcode_str:
            return ''
        return barcode_str.strip()

    def _clean_name(self, name_str):
        """Clean product name - remove extra spaces"""
        if not name_str:
            return ''
        return ' '.join(name_str.split())

    def _get_or_create_category(self, category_name):
        """Get or create a product category by name (e.g., 'All / Grocery')"""
        if not category_name or not category_name.strip():
            return None

        category_name = category_name.strip()
        ProductCategory = self.env['product.category']

        # Search by complete name (includes parent path like "All / Grocery")
        category = ProductCategory.search([('complete_name', '=', category_name)], limit=1)
        if category:
            return category.id

        # If not found, try to create it
        # Parse the hierarchy (e.g., "All / Grocery" -> parent="All", name="Grocery")
        parts = [p.strip() for p in category_name.split('/')]
        parent_id = None

        for part in parts:
            existing = ProductCategory.search([
                ('name', '=', part),
                ('parent_id', '=', parent_id)
            ], limit=1)

            if existing:
                parent_id = existing.id
            else:
                new_cat = ProductCategory.create({
                    'name': part,
                    'parent_id': parent_id,
                })
                parent_id = new_cat.id

        return parent_id

    def _get_or_create_pos_category(self, pos_category_name):
        """Get or create a POS category by name"""
        if not pos_category_name or not pos_category_name.strip():
            return None

        pos_category_name = pos_category_name.strip()
        PosCategory = self.env['pos.category']

        # Search by name
        category = PosCategory.search([('name', '=', pos_category_name)], limit=1)
        if category:
            return category.id

        # Create if not found
        new_cat = PosCategory.create({'name': pos_category_name})
        return new_cat.id

    def action_import(self):
        """Import products from CSV"""
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
        created = 0
        updated = 0
        skipped = 0
        errors = []

        ProductProduct = self.env['product.product']

        for row_num, row in enumerate(reader, start=2):
            try:
                if len(row) < 16:
                    skipped += 1
                    continue

                # New column indices
                barcode = self._clean_barcode(row[self.COL_BARCODE])  # Col I - Scale Reads
                name = self._clean_name(row[self.COL_NAME])           # Col J - Description 1
                unit_cost = self._clean_price(row[self.COL_UNIT_COST]) if len(row) > self.COL_UNIT_COST else None  # Col R
                sale_price = self._clean_price(row[self.COL_SALE_PRICE]) if len(row) > self.COL_SALE_PRICE else None  # Col S
                category_name = row[self.COL_CATEGORY].strip() if len(row) > self.COL_CATEGORY else ''  # Col U
                pos_category_name = row[self.COL_POS_CATEGORY].strip() if len(row) > self.COL_POS_CATEGORY else ''  # Col V
                available_in_pos_str = row[self.COL_AVAILABLE_POS].strip().upper() if len(row) > self.COL_AVAILABLE_POS else 'TRUE'  # Col W
                available_in_pos = available_in_pos_str in ('TRUE', 'YES', '1')

                # Skip rows without barcode or name
                if not barcode or not name:
                    skipped += 1
                    continue

                # Get or create categories
                categ_id = None
                pos_categ_id = None

                if self.update_category and category_name:
                    categ_id = self._get_or_create_category(category_name)

                if self.update_pos_category and pos_category_name:
                    pos_categ_id = self._get_or_create_pos_category(pos_category_name)

                # Search for existing product by barcode
                existing_product = ProductProduct.search([('barcode', '=', barcode)], limit=1)

                if existing_product:
                    # Update existing product
                    vals = {}

                    if self.update_name:
                        vals['name'] = name

                    if self.update_cost and unit_cost is not None:
                        vals['standard_price'] = unit_cost

                    if self.update_sale_price and sale_price is not None:
                        vals['list_price'] = sale_price

                    if self.update_purchase_desc:
                        vals['description_purchase'] = f"Vendor: {self.vendor_name}"

                    if self.update_category and categ_id:
                        vals['categ_id'] = categ_id

                    if self.update_pos_category and pos_categ_id:
                        vals['pos_categ_ids'] = [(6, 0, [pos_categ_id])]

                    # Update available_in_pos
                    vals['available_in_pos'] = available_in_pos

                    if vals:
                        existing_product.write(vals)
                        updated += 1
                    else:
                        skipped += 1

                elif self.create_new_products:
                    # Create new product
                    vals = {
                        'name': name,
                        'barcode': barcode,
                        'type': 'consu',
                        'available_in_pos': available_in_pos,
                        'description_purchase': f"Vendor: {self.vendor_name}",
                    }

                    if unit_cost is not None:
                        vals['standard_price'] = unit_cost

                    if sale_price is not None:
                        vals['list_price'] = sale_price

                    if categ_id:
                        vals['categ_id'] = categ_id

                    if pos_categ_id:
                        vals['pos_categ_ids'] = [(6, 0, [pos_categ_id])]

                    ProductProduct.create(vals)
                    created += 1
                else:
                    skipped += 1

            except Exception as e:
                errors.append(f"Row {row_num}: {str(e)}")

        # Build result message
        result_lines = [
            "=" * 50,
            "IMPORT COMPLETED",
            "=" * 50,
            f"✅ Products Created: {created}",
            f"✅ Products Updated: {updated}",
            f"⏭️  Rows Skipped: {skipped}",
        ]

        if errors:
            result_lines.append(f"\n❌ Errors ({len(errors)}):")
            for error in errors[:10]:  # Show first 10 errors
                result_lines.append(f"   - {error}")
            if len(errors) > 10:
                result_lines.append(f"   ... and {len(errors) - 10} more errors")

        self.result_message = "\n".join(result_lines)
        self.state = 'done'

        return {
            'type': 'ir.actions.act_window',
            'res_model': 'product.import.wizard',
            'res_id': self.id,
            'view_mode': 'form',
            'target': 'new',
        }

    def action_reset(self):
        """Reset the wizard to import another file"""
        self.ensure_one()
        self.write({
            'csv_file': False,
            'csv_filename': False,
            'result_message': False,
            'state': 'draft',
        })
        return {
            'type': 'ir.actions.act_window',
            'res_model': 'product.import.wizard',
            'res_id': self.id,
            'view_mode': 'form',
            'target': 'new',
        }

