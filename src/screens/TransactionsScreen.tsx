import React, { useState } from "react";
import {
	View,
	Text,
	StyleSheet,
	FlatList,
	TouchableOpacity,
	Image,
} from "react-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import { Platform } from "react-native";

import { theme } from "../theme";

type Transaction = {
	id: string;
	type: "income" | "expense";
	amount: number;
	category: string;
	supplier?: string;
	paymentType: string;
	date: string;
	image?: string;
};

const mockData: Transaction[] = [
	{
		id: "1",
		type: "expense",
		amount: 5000,
		category: "Stock",
		supplier: "Sharma Steel",
		paymentType: "cash",
		date: "2026-02-18",
	},
	{
		id: "2",
		type: "expense",
		amount: 2500,
		category: "Transport",
		supplier: "Gupta Traders",
		paymentType: "online",
		date: "2026-02-17",
		image: "https://via.placeholder.com/60",
	},
];

export default function TransactionsScreen() {
	const today = new Date();

	const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

	const [fromDate, setFromDate] = useState(firstDayOfMonth);
	const [toDate, setToDate] = useState(today);

	const [showFromPicker, setShowFromPicker] = useState(false);
	const [showToPicker, setShowToPicker] = useState(false);

	const formatDate = (date: Date) => {
		const year = date.getFullYear();
		const month = String(date.getMonth() + 1).padStart(2, "0");
		const day = String(date.getDate()).padStart(2, "0");
		return `${year}-${month}-${day}`;
	};

	const renderItem = ({ item }: { item: Transaction }) => {
		return (
			<View style={styles.card}>
				<View style={styles.rowTop}>
					<Text
						style={[
							theme.typography.bodyLarge,
							{
								color:
									item.type === "income"
										? theme.colors.income
										: theme.colors.expense,
							},
						]}
					>
						₹ {item.amount}
					</Text>

					<Text style={styles.dateText}>{item.date}</Text>
				</View>

				<Text style={styles.category}>{item.category}</Text>

				{item.supplier && (
					<Text style={styles.supplier}>Supplier: {item.supplier}</Text>
				)}

				<View style={styles.rowBottom}>
					<Text style={styles.paymentBadge}>
						{item.paymentType.toUpperCase()}
					</Text>

					{item.image && (
						<Image source={{ uri: item.image }} style={styles.thumbnail} />
					)}
				</View>
			</View>
		);
	};

	return (
		<View style={styles.container}>
			{/* FILTER SECTION */}
			<View style={styles.filterContainer}>
				<TouchableOpacity onPress={() => setShowFromPicker(true)}>
					<Text style={styles.filterText}>From: {formatDate(fromDate)}</Text>
				</TouchableOpacity>

				<TouchableOpacity onPress={() => setShowToPicker(true)}>
					<Text style={styles.filterText}>To: {formatDate(toDate)}</Text>
				</TouchableOpacity>
				<TouchableOpacity
					onPress={() => {
						setFromDate(firstDayOfMonth);
						setToDate(new Date());
					}}
				>
					<Text style={{ color: theme.colors.primary }}>This Month</Text>
				</TouchableOpacity>
			</View>

			<FlatList
				data={mockData}
				keyExtractor={(item) => item.id}
				renderItem={renderItem}
				contentContainerStyle={{ paddingBottom: 20 }}
			/>

			{showFromPicker && (
				<DateTimePicker
					value={fromDate}
					mode="date"
					display={Platform.OS === "ios" ? "spinner" : "default"}
					onChange={(event, selectedDate) => {
						setShowFromPicker(false);
						if (selectedDate) setFromDate(selectedDate);
					}}
				/>
			)}

			{showToPicker && (
				<DateTimePicker
					value={toDate}
					mode="date"
					display={Platform.OS === "ios" ? "spinner" : "default"}
					onChange={(event, selectedDate) => {
						setShowToPicker(false);
						if (selectedDate) setToDate(selectedDate);
					}}
				/>
			)}
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: theme.colors.background,
		padding: 16,
	},

	filterContainer: {
		flexDirection: "row",
		justifyContent: "space-between",
		marginBottom: 16,
		backgroundColor: theme.colors.card,
		padding: 12,
		borderRadius: 8,
	},

	filterText: {
		color: theme.colors.textPrimary,
		fontSize: 14,
	},

	card: {
		backgroundColor: theme.colors.card,
		padding: 14,
		borderRadius: 10,
		marginBottom: 12,
	},

	rowTop: {
		flexDirection: "row",
		justifyContent: "space-between",
	},

	rowBottom: {
		flexDirection: "row",
		justifyContent: "space-between",
		alignItems: "center",
		marginTop: 8,
	},

	dateText: {
		color: theme.colors.textSecondary,
		fontSize: 13,
	},

	category: {
		marginTop: 4,
		fontWeight: "600",
		color: theme.colors.textPrimary,
	},

	supplier: {
		marginTop: 2,
		color: theme.colors.textSecondary,
		fontSize: 13,
	},

	paymentBadge: {
		paddingHorizontal: 10,
		paddingVertical: 4,
		backgroundColor: theme.colors.primary,
		color: "#fff",
		borderRadius: 6,
		fontSize: 12,
	},

	thumbnail: {
		width: 40,
		height: 40,
		borderRadius: 6,
	},
});
