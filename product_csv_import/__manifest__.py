{
    'name': 'Product CSV Import Wizard',
    'version': '18.0.1.0.0',
    'category': 'Inventory',
    'summary': 'Import products from CSV and update existing by barcode',
    'description': """
        Import products from Diaz Foods CSV price list.
        
        Features:
        - Match existing products by barcode
        - Update name, cost, sale price, and purchase description
        - Keep existing barcodes in Odoo (won't overwrite)
        - Create new products if barcode doesn't exist
    """,
    'author': 'La Bodega',
    'depends': ['product', 'stock', 'point_of_sale'],
    'data': [
        'security/ir.model.access.csv',
        'views/import_wizard_views.xml',
    ],
    'installable': True,
    'application': False,
    'license': 'LGPL-3',
}

