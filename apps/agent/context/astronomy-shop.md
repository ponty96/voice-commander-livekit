# Astronomy Shop

## Overview
Astronomy Shop is an e-commerce application built using microservices.

Customers can browse products, add items to their carts,
and complete purchases through checkout.

## Architecture
The application consists of services responsible for:
- Product catalog and recommendations
- Shopping carts
- Checkout and payments
- Shipping and currency conversion
- Email notifications

## Main request flows
- Browsing: frontend calls product-catalog, recommendation, ad and currency.
- Cart: frontend calls cart, which stores carts in Valkey.
- Checkout (`oteldemo.CheckoutService/PlaceOrder`): checkout gets the cart, looks up each product in product-catalog, converts currency, gets a shipping quote (shipping, which calls quote), charges the card through payment, sends a confirmation through email, empties the cart and publishes the order to Kafka (`orders` topic). accounting and fraud-detection consume those orders.
- Services read feature flags from flagd.

## Observability
- Metrics: Prometheus, accessible through Grafana
- Logs: OpenSearch
- Traces: Jaeger
