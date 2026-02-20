import React from "react";
import { View, Text, FlatList, TouchableOpacity } from "react-native";
import { useRoute } from "@react-navigation/native";
import { theme } from "@theme";
import { styles } from "./SupplierDetail.styles";

type LedgerEntry = {
	id: string;
	date: string;
	description: string;
	debit: number;
	credit: number;
};

export default function SupplierDetailScreen() {
	const route: any = useRoute();
	const supplier = route.params?.supplier;

	const ledger: LedgerEntry[] = [
		{
			id: "1",
			date: "2026-02-10",
			description: "Stock Purchase",
			debit: 10000,
			credit: 0,
		},
		{
			id: "2",
			date: "2026-02-12",
			description: "Payment Made",
			debit: 0,
			credit: 4000,
		},
	];

	let runningBalance = 0;

	const renderItem = ({ item }: { item: LedgerEntry }) => {
		runningBalance = runningBalance + item.debit - item.credit;

		return (
			<View style={styles.card}>
				<Text style={styles.date}>{item.date}</Text>

				<Text style={styles.desc}>{item.description}</Text>

				<View style={styles.row}>
					<Text style={styles.debit}>
						{item.debit > 0 ? `₹ ${item.debit}` : "-"}
					</Text>

					<Text style={styles.credit}>
						{item.credit > 0 ? `₹ ${item.credit}` : "-"}
					</Text>

					<Text
						style={[
							styles.balance,
							{
								color:
									runningBalance > 0
										? theme.colors.expense
										: theme.colors.income,
							},
						]}
					>
						₹ {runningBalance}
					</Text>
				</View>
			</View>
		);
	};

	const totalDue = ledger.reduce(
		(acc, item) => acc + item.debit - item.credit,
		0,
	);

	return (
		<View style={styles.container}>
			{/* HEADER */}
			<View style={styles.header}>
				<Text style={styles.name}>{supplier?.name}</Text>
				<Text
					style={[
						styles.totalDue,
						{
							color: totalDue > 0 ? theme.colors.expense : theme.colors.income,
						},
					]}
				>
					₹ {totalDue}
				</Text>
			</View>

			{/* LEDGER LIST */}
			<FlatList
				data={ledger}
				keyExtractor={(item) => item.id}
				renderItem={renderItem}
				contentContainerStyle={{ paddingBottom: 20 }}
			/>

			{/* ACTION BUTTONS */}
			<View style={styles.actionRow}>
				<TouchableOpacity style={styles.button}>
					<Text style={styles.buttonText}>Add Expense</Text>
				</TouchableOpacity>

				<TouchableOpacity style={styles.button}>
					<Text style={styles.buttonText}>Record Payment</Text>
				</TouchableOpacity>
			</View>
		</View>
	);
}
