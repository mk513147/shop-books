import React from "react";
import { View, Text, StyleSheet, ScrollView } from "react-native";
import { theme } from "../theme";
import FloatingButton from "../components/FloatingButton";

export default function DashboardScreen() {
	const todayIncome = 12500;
	const todayExpense = 5200;
	const todayProfit = todayIncome - todayExpense;

	const monthIncome = 245000;
	const monthExpense = 180000;
	const monthProfit = monthIncome - monthExpense;

	const todayDate = new Date().toLocaleDateString();

	return (
		<ScrollView
			contentContainerStyle={styles.container}
			keyboardShouldPersistTaps="handled"
		>
			<View style={{ flex: 1 }}>
				<View>
					{/* DATE */}
					<Text style={styles.dateText}>{todayDate}</Text>

					{/* TODAY SECTION */}
					<Text style={styles.sectionTitle}>Today</Text>

					<View style={styles.summaryCard}>
						<Text style={styles.label}>Income</Text>
						<Text style={[styles.value, { color: theme.colors.income }]}>
							₹ {todayIncome}
						</Text>
					</View>

					<View style={styles.summaryCard}>
						<Text style={styles.label}>Expense</Text>
						<Text style={[styles.value, { color: theme.colors.expense }]}>
							₹ {todayExpense}
						</Text>
					</View>

					<View style={styles.profitCard}>
						<Text style={styles.label}>Profit</Text>
						<Text
							style={[
								styles.bigValue,
								{
									color:
										todayProfit >= 0
											? theme.colors.income
											: theme.colors.expense,
								},
							]}
						>
							₹ {todayProfit}
						</Text>
					</View>

					{/* MONTH SECTION */}
					<Text style={[styles.sectionTitle, { marginTop: 24 }]}>
						This Month
					</Text>

					<View style={styles.summaryCard}>
						<Text style={styles.label}>Income</Text>
						<Text style={[styles.value, { color: theme.colors.income }]}>
							₹ {monthIncome}
						</Text>
					</View>

					<View style={styles.summaryCard}>
						<Text style={styles.label}>Expense</Text>
						<Text style={[styles.value, { color: theme.colors.expense }]}>
							₹ {monthExpense}
						</Text>
					</View>

					<View style={styles.summaryCard}>
						<Text style={styles.label}>Profit</Text>
						<Text
							style={[
								styles.value,
								{
									color:
										monthProfit >= 0
											? theme.colors.income
											: theme.colors.expense,
								},
							]}
						>
							₹ {monthProfit}
						</Text>
					</View>
				</View>

				<FloatingButton />
			</View>
		</ScrollView>
	);
}

const styles = StyleSheet.create({
	container: {
		backgroundColor: theme.colors.background,
		padding: 16,
	},

	dateText: {
		fontSize: 14,
		color: theme.colors.textSecondary,
		marginBottom: 12,
	},

	sectionTitle: {
		fontSize: 18,
		fontWeight: "600",
		marginBottom: 12,
		color: theme.colors.textPrimary,
	},

	summaryCard: {
		backgroundColor: theme.colors.card,
		padding: 14,
		borderRadius: 10,
		marginBottom: 10,
	},

	profitCard: {
		backgroundColor: theme.colors.card,
		padding: 18,
		borderRadius: 10,
		marginBottom: 12,
	},

	label: {
		fontSize: 14,
		color: theme.colors.textSecondary,
	},

	value: {
		fontSize: 18,
		fontWeight: "600",
		marginTop: 4,
	},

	bigValue: {
		fontSize: 26,
		fontWeight: "700",
		marginTop: 6,
	},
});
