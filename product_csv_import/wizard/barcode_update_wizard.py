# -*- coding: utf-8 -*-
import base64
import csv
import io
from odoo import models, fields, api, _
from odoo.exceptions import UserError


class BarcodeUpdateWizard(models.TransientModel):
    _name = 'barcode.update.wizard'
    _description = 'Update Product Barcodes from CSV'

    csv_file = fields.Binary(string='CSV File', required=True)
    csv_filename = fields.Char(string='Filename')

    state = fields.Selection([
        ('draft', 'Upload'),
        ('preview', 'Preview'),
        ('done', 'Done'),
    ], default='draft')

    # Preview results
    preview_line_ids = fields.One2many('barcode.update.wizard.line', 'wizard_id', string='Preview Lines')

    # Statistics
    total_rows = fields.Integer(string='Total Rows', readonly=True)
    products_found = fields.Integer(string='Products Found', readonly=True)
    products_not_found = fields.Integer(string='Products Not Found', readonly=True)
    duplicates_found = fields.Integer(string='Duplicate New Barcodes', readonly=True)

    # Result
    result_message = fields.Text(string='Result', readonly=True)

    def action_preview(self):
        """Parse CSV and show preview of changes"""
        self.ensure_one()

        if not self.csv_file:
            raise UserError(_('Please upload a CSV file.'))

        # Clear previous preview lines
        self.preview_line_ids.unlink()

        # Decode CSV file
        try:
            csv_data = base64.b64decode(self.csv_file)
            csv_string = csv_data.decode('utf-8')
        except Exception as e:
            raise UserError(_('Error reading CSV file: %s') % str(e))

        # Parse CSV
        reader = csv.reader(io.StringIO(csv_string))

        # Skip header row
        try:
            header = next(reader)
        except StopIteration:
            raise UserError(_('CSV file is empty.'))

        # Validate header
        if len(header) < 2:
            raise UserError(_('CSV must have at least 2 columns: Current Barcode, New Barcode'))

        # Check if product_id column exists (look for it in any position)
        product_id_col = None
        for idx, col in enumerate(header):
            if 'product_id' in col.lower().replace(' ', '_'):
                product_id_col = idx
                break

        lines_data = []
        new_barcodes = {}  # Track duplicates
        total_rows = 0
        products_found = 0
        products_not_found = 0
        duplicates_found = 0

        ProductProduct = self.env['product.product']

        for row_num, row in enumerate(reader, start=2):
            if len(row) < 2:
                continue

            current_barcode = row[0].strip() if row[0] else ''
            new_barcode = row[1].strip() if row[1] else ''

            # Try to get product_id from CSV if column exists
            product_id_from_csv = None
            if product_id_col is not None and len(row) > product_id_col:
                try:
                    product_id_from_csv = int(row[product_id_col].strip())
                except (ValueError, TypeError):
                    pass

            if not current_barcode and not product_id_from_csv:
                continue

            total_rows += 1

            # Find product - prefer product_id if available, fallback to barcode search
            product = None
            if product_id_from_csv:
                product = ProductProduct.browse(product_id_from_csv).exists()

            if not product and current_barcode:
                # Try exact match first
                product = ProductProduct.search([('barcode', '=', current_barcode)], limit=1)

                # If not found and barcode starts with 0, try without leading zeros
                if not product and current_barcode.startswith('0'):
                    barcode_no_zeros = current_barcode.lstrip('0')
                    product = ProductProduct.search([('barcode', '=', barcode_no_zeros)], limit=1)

                # If not found and barcode doesn't start with 0, try with leading zeros
                if not product and not current_barcode.startswith('0'):
                    # Try adding leading zeros to make it 12 digits
                    if len(current_barcode) < 12:
                        barcode_with_zeros = current_barcode.zfill(12)
                        product = ProductProduct.search([('barcode', '=', barcode_with_zeros)], limit=1)

            status = 'ready'
            notes = ''
            product_id = False
            product_name = ''

            if not product:
                status = 'not_found'
                notes = 'Product not found with this barcode'
                products_not_found += 1
            else:
                product_id = product.id
                product_name = product.name
                products_found += 1

                # Check if new barcode is empty
                if not new_barcode:
                    status = 'skip'
                    notes = 'New barcode is empty'
                # Check if new barcode same as current
                elif new_barcode == current_barcode:
                    status = 'skip'
                    notes = 'New barcode same as current'
                # Check if new barcode same as product's current barcode
                elif new_barcode == product.barcode:
                    status = 'skip'
                    notes = 'New barcode same as current product barcode'
                # Check for duplicate new barcodes in this file
                elif new_barcode in new_barcodes:
                    status = 'duplicate'
                    notes = f'Duplicate: same new barcode on row {new_barcodes[new_barcode]}'
                    duplicates_found += 1
                # Check if new barcode already exists in database
                else:
                    existing = ProductProduct.search([('barcode', '=', new_barcode)], limit=1)
                    if existing and existing.id != product.id:
                        status = 'conflict'
                        notes = f'Barcode already exists on: {existing.name}'
                    else:
                        new_barcodes[new_barcode] = row_num

            lines_data.append({
                'wizard_id': self.id,
                'row_number': row_num,
                'current_barcode': current_barcode,
                'new_barcode': new_barcode,
                'product_id': product_id,
                'product_name': product_name,
                'status': status,
                'notes': notes,
            })

        # Create preview lines
        self.env['barcode.update.wizard.line'].create(lines_data)

        # Update statistics
        self.write({
            'state': 'preview',
            'total_rows': total_rows,
            'products_found': products_found,
            'products_not_found': products_not_found,
            'duplicates_found': duplicates_found,
        })

        return {
            'type': 'ir.actions.act_window',
            'res_model': 'barcode.update.wizard',
            'res_id': self.id,
            'view_mode': 'form',
            'target': 'new',
        }

    def action_apply(self):
        """Apply the barcode updates"""
        self.ensure_one()

        updated = 0
        skipped = 0
        errors = []

        for line in self.preview_line_ids:
            if line.status == 'ready' and line.product_id:
                try:
                    line.product_id.write({'barcode': line.new_barcode})
                    updated += 1
                except Exception as e:
                    errors.append(f'Row {line.row_number}: {str(e)}')
            else:
                skipped += 1

        result_msg = f"""
Barcode Update Complete!
========================
✅ Updated: {updated} products
⏭️ Skipped: {skipped} rows
"""
        if errors:
            result_msg += f"\n❌ Errors ({len(errors)}):\n" + "\n".join(errors[:10])
            if len(errors) > 10:
                result_msg += f"\n... and {len(errors) - 10} more errors"

        self.write({
            'state': 'done',
            'result_message': result_msg,
        })

        return {
            'type': 'ir.actions.act_window',
            'res_model': 'barcode.update.wizard',
            'res_id': self.id,
            'view_mode': 'form',
            'target': 'new',
        }

    def action_back(self):
        """Go back to upload state"""
        self.ensure_one()
        self.preview_line_ids.unlink()
        self.write({
            'state': 'draft',
            'total_rows': 0,
            'products_found': 0,
            'products_not_found': 0,
            'duplicates_found': 0,
            'result_message': False,
        })
        return {
            'type': 'ir.actions.act_window',
            'res_model': 'barcode.update.wizard',
            'res_id': self.id,
            'view_mode': 'form',
            'target': 'new',
        }


class BarcodeUpdateWizardLine(models.TransientModel):
    _name = 'barcode.update.wizard.line'
    _description = 'Barcode Update Wizard Line'

    wizard_id = fields.Many2one('barcode.update.wizard', string='Wizard', required=True, ondelete='cascade')
    row_number = fields.Integer(string='Row')
    current_barcode = fields.Char(string='Current Barcode')
    new_barcode = fields.Char(string='New Barcode')
    product_id = fields.Many2one('product.product', string='Product')
    product_name = fields.Char(string='Product Name')
    status = fields.Selection([
        ('ready', 'Ready'),
        ('not_found', 'Not Found'),
        ('skip', 'Skip'),
        ('duplicate', 'Duplicate'),
        ('conflict', 'Conflict'),
    ], string='Status', default='ready')
    notes = fields.Char(string='Notes')




