from odoo import models, fields, api, _
from odoo.exceptions import UserError


class ProductLabelWizard(models.TransientModel):
    _name = 'product.label.wizard'
    _description = 'Print Product Labels'

    product_ids = fields.Many2many(
        'product.product',
        string='Products',
        required=True,
        help='Select products to print labels for'
    )
    copies = fields.Integer(
        string='Copies per Product',
        default=1,
        help='Number of labels to print for each product'
    )

    @api.model
    def default_get(self, fields_list):
        """Get default values - automatically select products from active_ids"""
        res = super().default_get(fields_list)
        if self.env.context.get('active_model') == 'product.product':
            active_ids = self.env.context.get('active_ids', [])
            if active_ids:
                res['product_ids'] = [(6, 0, active_ids)]
        elif self.env.context.get('active_model') == 'product.template':
            active_ids = self.env.context.get('active_ids', [])
            if active_ids:
                templates = self.env['product.template'].browse(active_ids)
                product_ids = templates.mapped('product_variant_ids').ids
                res['product_ids'] = [(6, 0, product_ids)]
        return res

    def action_print_labels(self):
        """Print the product labels"""
        self.ensure_one()

        if not self.product_ids:
            raise UserError(_('Please select at least one product.'))

        # Generate the list of products with copies
        products_data = []
        for product in self.product_ids:
            for _ in range(self.copies):
                products_data.append(product.id)

        # Return the report action
        return self.env.ref('product_csv_import.action_report_product_labels').report_action(
            self.product_ids.ids,
            data={'product_ids': products_data, 'copies': self.copies}
        )


class ProductLabelReport(models.AbstractModel):
    _name = 'report.product_csv_import.report_product_labels'
    _description = 'Product Label Report'

    @api.model
    def _get_report_values(self, docids, data=None):
        """Get the data for the report"""
        if data and data.get('product_ids'):
            # Get products in the order specified (with copies)
            product_ids = data.get('product_ids', [])
            products = []
            for pid in product_ids:
                products.append(self.env['product.product'].browse(pid))
        else:
            # Fallback to docids
            products = self.env['product.product'].browse(docids)

        return {
            'doc_ids': docids,
            'doc_model': 'product.product',
            'docs': products,
            'data': data,
        }

