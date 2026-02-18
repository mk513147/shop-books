import React from "react";
import {
	View,
	Text,
	StyleSheet,
	FlatList,
	TouchableOpacity,
} from "react-native";
import { useNavigation } from "@react-navigation/native";
import { theme } from "../theme";

type Supplier = {
	id: string;
	name: string;
	due: number;
};

const mockSuppliers: Supplier[] = [
	{ id: "1", name: "Sharma Steel", due: 4000 },
	{ id: "2", name: "Gupta Traders", due: 0 },
	{ id: "3", name: "ABC Supplies", due: 12000 },
];

export default function SuppliersScreen() {
	const navigation: any = useNavigation();

	const renderItem = ({ item }: { item: Supplier }) => {
		const hasDue = item.due > 0;

		return (
			<TouchableOpacity
				style={styles.card}
				onPress={() =>
					navigation.navigate("SupplierDetail", { supplier: item })
				}
			>
				<View style={styles.row}>
					<Text style={styles.name}>{item.name}</Text>

					<Text
						style={[
							styles.due,
							{
								color: hasDue ? theme.colors.expense : theme.colors.income,
							},
						]}
					>
						₹ {item.due}
					</Text>
				</View>

				<Text style={styles.status}>{hasDue ? "Pending Due" : "No Due"}</Text>
			</TouchableOpacity>
		);
	};

	return (
		<View style={styles.container}>
			<FlatList
				data={mockSuppliers}
				keyExtractor={(item) => item.id}
				renderItem={renderItem}
				contentContainerStyle={{ paddingBottom: 20 }}
			/>
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: theme.colors.background,
		padding: 16,
	},

	card: {
		backgroundColor: theme.colors.card,
		padding: 16,
		borderRadius: 10,
		marginBottom: 12,
	},

	row: {
		flexDirection: "row",
		justifyContent: "space-between",
		alignItems: "center",
	},

	name: {
		fontSize: 16,
		fontWeight: "600",
		color: theme.colors.textPrimary,
	},

	due: {
		fontSize: 16,
		fontWeight: "700",
	},

	status: {
		marginTop: 6,
		fontSize: 13,
		color: theme.colors.textSecondary,
	},
});
