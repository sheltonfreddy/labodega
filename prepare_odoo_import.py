#!/usr/bin/env python3
"""
Prepare Diaz Foods CSV for Odoo Import

This script transforms the Diaz Foods price list into an Odoo-compatible CSV
for importing/updating products.

Key features:
- Uses barcode as External ID for matching existing products
- Updates: name, cost (standard_price), sale price (list_price), and purchase description
- Preserves existing barcodes in Odoo (won't overwrite with blank)
- Sets vendor name in purchase description field
"""

import csv

# Input and output files
INPUT_FILE = 'DiazFoods_LabodegaPriceList.csv'
OUTPUT_FILE = 'odoo_product_import.csv'
VENDOR_NAME = 'DIAZ FOODS'

def clean_price(price_str):
    """Remove $ and convert to float"""
    if not price_str or price_str.strip() == '':
        return None
    # Remove $ and any commas
    cleaned = price_str.replace('$', '').replace(',', '').strip()
    try:
        return float(cleaned)
    except ValueError:
        return None

def clean_barcode(barcode_str):
    """Clean barcode - remove spaces"""
    if not barcode_str:
        return ''
    return barcode_str.strip()

def clean_name(name_str):
    """Clean product name - remove extra spaces"""
    if not name_str:
        return ''
    return ' '.join(name_str.split())

def main():
    products = {}  # Use dict to deduplicate by barcode
    products_with_prices = 0
    products_without_prices = 0

    with open(INPUT_FILE, 'r', encoding='utf-8') as f:
        reader = csv.reader(f)
        header = next(reader)  # Skip header row

        for row in reader:
            if len(row) < 17:
                continue

            barcode = clean_barcode(row[6])
            name = clean_name(row[7])
            unit_cost = clean_price(row[15]) if len(row) > 15 else None
            sale_price = clean_price(row[16]) if len(row) > 16 else None

            # Skip rows without barcode or name
            if not barcode or not name:
                continue

            # Use barcode as key to deduplicate (keep first occurrence or update with better data)
            if barcode not in products:
                products[barcode] = {
                    'barcode': barcode,
                    'name': name,
                    'unit_cost': unit_cost,
                    'sale_price': sale_price,
                }
            else:
                # Update with non-empty values if current is empty
                if unit_cost and products[barcode]['unit_cost'] is None:
                    products[barcode]['unit_cost'] = unit_cost
                if sale_price and products[barcode]['sale_price'] is None:
                    products[barcode]['sale_price'] = sale_price

    # Count products with/without prices
    for p in products.values():
        if p['unit_cost'] is not None and p['sale_price'] is not None:
            products_with_prices += 1
        else:
            products_without_prices += 1

    # Write Odoo import CSV
    with open(OUTPUT_FILE, 'w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f)

        # Odoo column headers
        writer.writerow([
            'id',                    # External ID for matching
            'barcode',               # Barcode
            'name',                  # Product Name
            'list_price',            # Sale Price
            'standard_price',        # Cost
            'description_purchase',  # Purchase Description (vendor name)
            'detailed_type',         # Product Type
            'available_in_pos',      # Available in POS
        ])

        for barcode, product in products.items():
            # Create External ID from barcode (use prefix to make it valid)
            external_id = f'product_barcode_{barcode}'

            # Only include prices if they have values
            sale_price = product['sale_price'] if product['sale_price'] is not None else ''
            unit_cost = product['unit_cost'] if product['unit_cost'] is not None else ''

            writer.writerow([
                external_id,
                product['barcode'],
                product['name'],
                sale_price,
                unit_cost,
                f"Vendor: {VENDOR_NAME}",  # Purchase description with vendor
                'consu',                    # Consumable product type
                'TRUE',                     # Available in POS
            ])

    print(f"✅ Created {OUTPUT_FILE}")
    print(f"   - Total unique products: {len(products)}")
    print(f"   - Products WITH prices: {products_with_prices}")
    print(f"   - Products WITHOUT prices: {products_without_prices}")
    print(f"\n⚠️  Note: Products without prices will have empty price fields.")
    print(f"   Odoo will keep existing prices for those products.\n")

if __name__ == '__main__':
    main()


