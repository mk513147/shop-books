import React from "react";
import { View, Text, StyleSheet, Dimensions } from "react-native";
import { BarChart } from "react-native-chart-kit";
import { theme } from "@theme";

const screenWidth = Dimensions.get("window").width;

export default function ReportsScreen() {
	const totalIncome = 245000;
	const totalExpense = 180000;
	const profit = totalIncome - totalExpense;

	const cashSpent = 120000;
	const onlineSpent = 60000;

	return (
		<View style={styles.container}>
			<Text style={styles.monthLabel}>This Month</Text>

			{/* SUMMARY CARDS */}
			<View style={styles.summaryRow}>
				<View style={styles.card}>
					<Text style={styles.label}>Income</Text>
					<Text style={[styles.value, { color: theme.colors.income }]}>
						₹ {totalIncome}
					</Text>
				</View>

				<View style={styles.card}>
					<Text style={styles.label}>Expense</Text>
					<Text style={[styles.value, { color: theme.colors.expense }]}>
						₹ {totalExpense}
					</Text>
				</View>
			</View>

			<View style={styles.cardFull}>
				<Text style={styles.label}>Net Profit</Text>
				<Text
					style={[
						styles.value,
						{
							color: profit >= 0 ? theme.colors.income : theme.colors.expense,
						},
					]}
				>
					₹ {profit}
				</Text>
			</View>

			{/* BAR CHART */}
			<Text style={styles.sectionTitle}>Income vs Expense</Text>

			<BarChart
				data={{
					labels: ["Income", "Expense"],
					datasets: [
						{
							data: [totalIncome, totalExpense],
						},
					],
				}}
				width={screenWidth - 32}
				height={220}
				yAxisLabel="₹ "
				yAxisSuffix=""
				chartConfig={{
					backgroundColor: theme.colors.card,
					backgroundGradientFrom: theme.colors.card,
					backgroundGradientTo: theme.colors.card,
					decimalPlaces: 0,
					color: () => theme.colors.primary,
					labelColor: () => theme.colors.textPrimary,
				}}
				style={{
					borderRadius: 10,
					marginVertical: 8,
				}}
			/>

			{/* PAYMENT BREAKDOWN */}
			<Text style={styles.sectionTitle}>Payment Breakdown</Text>

			<View style={styles.cardFull}>
				<Text style={styles.breakdownText}>Cash Spent: ₹ {cashSpent}</Text>
				<Text style={styles.breakdownText}>Online Spent: ₹ {onlineSpent}</Text>
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: theme.colors.background,
		padding: 16,
	},

	monthLabel: {
		fontSize: 18,
		fontWeight: "600",
		marginBottom: 12,
		color: theme.colors.textPrimary,
	},

	summaryRow: {
		flexDirection: "row",
		justifyContent: "space-between",
		marginBottom: 12,
	},

	card: {
		flex: 1,
		backgroundColor: theme.colors.card,
		padding: 14,
		borderRadius: 10,
		marginHorizontal: 4,
	},

	cardFull: {
		backgroundColor: theme.colors.card,
		padding: 14,
		borderRadius: 10,
		marginBottom: 16,
	},

	label: {
		fontSize: 14,
		color: theme.colors.textSecondary,
	},

	value: {
		fontSize: 20,
		fontWeight: "700",
		marginTop: 6,
	},

	sectionTitle: {
		fontSize: 16,
		fontWeight: "600",
		marginBottom: 8,
		marginTop: 10,
		color: theme.colors.textPrimary,
	},

	breakdownText: {
		fontSize: 14,
		marginVertical: 4,
		color: theme.colors.textPrimary,
	},
});
