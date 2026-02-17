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
    create_new_products = fields.Boolean(string='Create New Products', default=True,
                                          help='If unchecked, only existing products will be updated')

    # Results
    result_message = fields.Text(string='Import Result', readonly=True)
    state = fields.Selection([
        ('draft', 'Draft'),
        ('done', 'Done'),
    ], default='draft')

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
                if len(row) < 17:
                    continue

                barcode = self._clean_barcode(row[6])
                name = self._clean_name(row[7])
                unit_cost = self._clean_price(row[15]) if len(row) > 15 else None
                sale_price = self._clean_price(row[16]) if len(row) > 16 else None

                # Skip rows without barcode or name
                if not barcode or not name:
                    skipped += 1
                    continue

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
                        'detailed_type': 'consu',
                        'available_in_pos': True,
                        'description_purchase': f"Vendor: {self.vendor_name}",
                    }

                    if unit_cost is not None:
                        vals['standard_price'] = unit_cost

                    if sale_price is not None:
                        vals['list_price'] = sale_price

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

