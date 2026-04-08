# SageAssist2 — Feature Ideas

Feature suggestions based on analysis of the existing codebase, grouped by business area. Ordered roughly by potential impact.

---

## 📊 Sales & Revenue Intelligence

### 1. Sales Forecasting
Predict future revenue using historical invoice data (you already have YoY comparison infrastructure). Show projected monthly/quarterly targets vs actuals with confidence bands.

### 2. Customer Lifetime Value (CLV) Scoring
Extend the existing `CustomerLifetimeStatsModel` into a proper CLV score. Combine order frequency, AOV, tenure, and margin data into a single composite score per customer. Surface on the Customer and Account Manager pages.

### 3. Sales Pipeline / Quotation Conversion Tracker
You have `SalesQuotationModels` — build a view that tracks quotes → orders conversion rate over time, average time-to-close, and identifies stale quotes that need follow-up.

### 4. Cross-Sell / Up-Sell Recommendations
Analyse which products are frequently ordered together (market basket analysis on invoice lines). Surface "Customers who bought X also buy Y" on the Customer and Stock Detail pages.

### 5. Price Erosion Detection
Track average selling price per stock item over time. Flag items where the ASP is declining, indicating creeping discounts or competitive pressure. Extend the existing `StockItemPricingModel`.

---

## 👥 Customer Management

### 6. Customer Segmentation (ABC Analysis)
Classify customers into A/B/C tiers based on revenue contribution (Pareto 80/20). Help account managers focus effort on high-value accounts and identify growth opportunities in B-tier.

### 7. Customer Credit Risk Dashboard
Combine credit limit data (already fetched in churn analysis), payment history from Sage aged debtors, and order patterns to flag customers approaching or exceeding credit limits, or with deteriorating payment behaviour.

### 8. Customer Contact / Activity Log
Add a simple CRM-lite note system — log calls, emails, visit notes against customer accounts. Could reuse the RMA database pattern (EF Core) for storage. Would complement the churn risk feature.

### 9. Overdue Invoice Alerts
Pull Sage aged debtor data and surface overdue invoices per customer/account manager. Show ageing buckets (30/60/90+ days) and link to customer pages.

---

## 📦 Stock & Inventory

### 10. Stock Valuation Summary
Surface total inventory value by warehouse, product group, or supplier. Identify where capital is tied up in slow-moving stock (combines your slow-moving and stock detail data).

### 11. Dead Stock Identification
Go beyond "slow moving" — flag items with zero sales in 6-12+ months that still have stock. Calculate the write-off risk value and suggest clearance actions.

### 12. Supplier Lead Time Tracking
Track the gap between PO creation date and goods-received date per supplier. Show average, best, and worst lead times. Feed this into the reorder suggestion algorithm for smarter timing.

### 13. Stock Availability Dashboard
Real-time view of stock availability across key items: free stock, allocated, on order, back-ordered. Could show a traffic light system per product group.

### 14. BOM / Kit Component Availability
If you handle kits or assembled items, show component-level stock availability and flag when a kit can't be fulfilled due to a missing component.

---

## 🔄 RMA & Returns

### 15. Warranty Expiry Tracker
You already have `ProductWarrantyModel` — build a page that shows products approaching warranty expiry for specific customers. Could generate proactive outreach lists.

### 16. RMA Cost Impact Analysis
Extend RMA analytics to calculate the true cost of returns: replacement cost, shipping, labour, and the margin impact. Show cost-of-quality metrics over time.

### 17. Supplier Fault Rate Scorecard
Aggregate RMA data by supplier to identify which suppliers have the highest return rates. Could inform purchasing decisions and supplier negotiations.

---

## 🏭 Purchasing & Supplier

### 18. Supplier Performance Scorecard
Combine lead time accuracy, quality (RMA rates), pricing competitiveness, and fill rates into a composite supplier rating. Surface on the Supplier page.

### 19. PO Commitment / Spend Analysis
Show total committed PO value vs budget per period, broken down by supplier or product group. Help purchasing see spend concentration and identify savings opportunities.

### 20. Minimum Order Quantity (MOQ) Optimiser
When reorder suggestions are generated, factor in supplier MOQs and suggest batching multiple products into a single PO to meet minimums and reduce freight costs.

---

## 📈 Analytics & Reporting

### 21. Scheduled / Emailed Reports
Auto-generate key reports (dashboard summary, churn risk, low value orders) on a schedule and email them to account managers. You already have `ExceptionEmailService` infrastructure.

### 22. Custom Dashboard Widgets
Let users pin their most-used KPIs and charts to a personalised dashboard. Store preferences per user in the settings system.

### 23. Export to Excel (Universal)
Add an "Export to Excel" button across all data grids. You already have CSV export on traceable data — generalise this pattern to all pages.

### 24. Audit Trail / Change Log
Log who changed RMA statuses, settings, etc. into a searchable audit trail. Useful for accountability and compliance.

---

## 🔧 Operational & UX

### 25. Notification Centre
Centralise alerts (new RMAs, churn risk changes, stock running low, overdue invoices) into a notification bell in the top bar with badge counts. You already have the RMA badge pattern.

### 26. Global Search
Add a universal search bar that can find customers, stock items, orders, RMAs, and suppliers from one input. Jump directly to the relevant detail page.

### 27. Favourites / Bookmarks
Let users bookmark frequently accessed customers, stock items, or suppliers for quick access from a pinned section.

### 28. Role-Based View Filtering
Automatically scope data to the logged-in user's role (e.g., account managers only see their customers by default). You already have `AppState.CurrentUser` and impersonation.

---

## 💡 Advanced / Longer Term

### 29. GP Leakage Alert System
Automatically flag orders where GP margin falls below a configurable threshold at the point of order entry or invoice. Complement the existing Profit Margin page.

### 30. Customer Delivery Performance
Track on-time delivery rates per customer or product group. Identify if late deliveries correlate with churn risk.

### 31. Multi-Currency Margin Analysis
Extend profit margin calculations to account for FX fluctuations on import costs (you already have `CurrencyService`). Show the margin impact of currency movements.

### 32. Integration with APC Tracking
You have `ApcDetailedTrackingService` — surface delivery tracking status directly on sales order and back order views so users don't need to look it up separately.
