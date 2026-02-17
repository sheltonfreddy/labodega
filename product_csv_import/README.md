# Product CSV Import Wizard

An Odoo 18 module to import products from Diaz Foods CSV price lists.

## Features

- **Match by Barcode**: Finds existing products by barcode and updates them
- **Selective Updates**: Choose which fields to update:
  - Product Name
  - Cost (standard_price)
  - Sale Price (list_price)
  - Purchase Description (vendor name)
- **Create New Products**: Optionally create products if barcode doesn't exist
- **Preserve Existing Data**: Only updates fields you select; keeps existing barcodes

## Installation

1. Copy the `product_csv_import` folder to your Odoo addons directory
2. Restart Odoo
3. Go to Apps, click "Update Apps List"
4. Search for "Product CSV Import Wizard" and install it

## Usage

### Step 1: Open the Wizard
- Go to **Inventory** → **Configuration** → **Import Products (CSV)**
- OR **Inventory** → **Products** → **Import Products (CSV)**

### Step 2: Upload CSV
- Click on the file upload field
- Select your `DiazFoods_LabodegaPriceList.csv` file

### Step 3: Configure Options
- **Vendor Name**: Set to "DIAZ FOODS" (or your vendor)
- **Update Product Name**: ✅ Check to update names
- **Update Cost**: ✅ Check to update cost prices
- **Update Sale Price**: ✅ Check to update sale prices
- **Update Purchase Description**: ✅ Check to add vendor info
- **Create New Products**: ✅ Check to create products for new barcodes

### Step 4: Import
- Click **"Import Products"**
- Review the results showing:
  - Products Created
  - Products Updated
  - Rows Skipped
  - Any errors

## CSV Format Expected

The wizard expects the Diaz Foods CSV format:

| Column | Index | Field |
|--------|-------|-------|
| Barcode | 6 | Product barcode |
| Description 1 | 7 | Product name |
| Unit Cost | 15 | Cost price |
| Sale Price | 16 | Retail price |

## How It Works

```
For each row in CSV:
  1. Read barcode from column 6
  2. Search Odoo for product with matching barcode
  3. If found → UPDATE the selected fields
  4. If not found → CREATE new product (if option enabled)
  5. Skip rows without barcode or name
```

## Example

**Before Import:**
- Product exists with barcode `730399009017`
- Name: "Old Name"
- Price: $5.00

**After Import:**
- Same barcode `730399009017` (preserved!)
- Name: "SI SENOR CHAMOY 33OZ" (updated)
- Price: $2.99 (updated)
- Purchase Description: "Vendor: DIAZ FOODS" (added)

## Troubleshooting

**Q: Products are being duplicated instead of updated**
A: Make sure the barcode in the CSV exactly matches the barcode in Odoo (no extra spaces)

**Q: Prices not updating**
A: Check that the CSV has values in columns 15 and 16 (Unit Cost and Sale Price). Some rows may be empty.

**Q: Import is slow**
A: For large CSVs (600+ products), the import may take 1-2 minutes. Be patient.

